//! MCP 厂商标识：从 Target 的注册域抓取站点图标，统一成最长边 ≤64 px 的 PNG / SVG data URL。
//!
//! 图标只是识别辅助，因此所有失败都收敛成 [`McpIconSource::None`]，不向上抛错。
//! Target 可能带 OAuth 回调参数或密钥，所以缓存键与网络请求都只用注册域，
//! 任何日志、缓存文件、返回值都不出现 Target 原文。
//!
//! 下载统一走 [`crate::skin_net`] 的安全 HTTPS 客户端（DNS 校验 + 私网拦截）。

use std::collections::HashSet;
use std::fs;
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use image::imageops::FilterType;
use image::{DynamicImage, ImageFormat, ImageReader, Limits};
use scraper::{Html, Selector};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use url::Url;

use crate::paths;
use crate::skin_net::{self, OriginPolicy};

/// 站点根文档上限：只看 `<head>` 里的 `<link>`，256 KiB 足够覆盖声明。
const SITE_DOC_MAX_BYTES: u64 = 256 * 1024;
/// 单个图标候选上限，与 ADR 0006 的安全边界一致。
const ICON_MAX_BYTES: u64 = 512 * 1024;
/// SVG 原样返回，但仍要限制体积，避免把巨型 SVG 塞进 data URL。
const SVG_MAX_BYTES: usize = 256 * 1024;
/// 统一输出边长；设置页按 32–40 px 显示，2× 屏足够。
const ICON_MAX_EDGE: u32 = 64;
const ICON_DECODE_MAX_DIMENSION: u32 = 4_096;
const ICON_DECODE_MAX_PIXELS: u64 = 16_000_000;
const ICON_DECODE_MAX_ALLOC: u64 = 64 * 1024 * 1024;
/// 整轮解析（站点文档 + 全部候选）的总预算；单次请求自身的超时更长，
/// 这里靠外层 timeout 取消，避免慢域名拖住设置页。
const RESOLVE_TOTAL_TIMEOUT: Duration = Duration::from_secs(8);
const SUCCESS_TTL_SECS: u64 = 30 * 24 * 60 * 60;
const NONE_TTL_SECS: u64 = 7 * 24 * 60 * 60;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum McpIconSource {
    Site,
    Favicon,
    None,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpIconResult {
    pub data_url: Option<String>,
    pub domain: Option<String>,
    pub source: McpIconSource,
    pub from_cache: bool,
}

impl McpIconResult {
    fn unresolved() -> Self {
        Self {
            data_url: None,
            domain: None,
            source: McpIconSource::None,
            from_cache: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct IconTarget {
    host: String,
    domain: String,
}

/// 缓存条目只保存域名与图标；`fetched_at` 为 Unix 秒。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CacheEntry {
    domain: String,
    data_url: Option<String>,
    source: McpIconSource,
    fetched_at: u64,
}

impl CacheEntry {
    /// 缓存文件可被本地进程改写，读回时按外部输入校验，避免把任意字符串
    /// 当作 data URL 交给前端 `<img>`。
    fn is_sane(&self) -> bool {
        let domain_ok = !self.domain.is_empty()
            && self.domain.len() <= 253
            && self
                .domain
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '.'));
        if !domain_ok {
            return false;
        }
        match (&self.data_url, self.source) {
            (None, McpIconSource::None) => true,
            (Some(url), source) if source != McpIconSource::None => {
                let allowed_prefix = url.starts_with("data:image/png;base64,")
                    || url.starts_with("data:image/svg+xml;base64,");
                allowed_prefix && url.len() <= 2 * 1024 * 1024
            }
            _ => false,
        }
    }
}

#[derive(Debug, Clone)]
struct SiteIconCandidate {
    url: String,
    apple_touch: bool,
    svg: bool,
    size: u32,
    order: usize,
}

/// Target → 主机 + 注册域。这里的拒绝条件只做快速剪枝；私网解析由
/// `skin_net` 在每次请求前校验。
fn parse_target(target: &str) -> Option<IconTarget> {
    let url = Url::parse(target.trim()).ok()?;
    if url.scheme() != "https" {
        return None;
    }
    if !url.username().is_empty() || url.password().is_some() {
        return None;
    }
    let host = url.host_str()?.trim_end_matches('.').to_ascii_lowercase();
    // 图标只对域名有意义；IP 字面量（含私网）直接拒绝，不依赖 DNS 层兜底。
    if host.parse::<std::net::IpAddr>().is_ok() {
        return None;
    }
    let valid_host = host.contains('.')
        && !host.starts_with('.')
        && host != "localhost"
        && !host.ends_with(".localhost")
        && !host.ends_with(".local");
    if !valid_host {
        return None;
    }
    // 注册域必须被 PSL 认可。`https://github.io/mcp` 这类「主机名本身就是公共后缀」
    // 的 Target 会让域策略覆盖所有租户，直接拒绝而不是退化成 host。
    let domain = psl::domain_str(&host)?.to_ascii_lowercase();
    Some(IconTarget { host, domain })
}

/// 用 Public Suffix List 求注册域；列表不认识的 TLD 回退到主机名本身，
/// 保证自定义内网域名也能尝试取 `favicon.ico`。
fn registrable_domain(host: &str) -> String {
    let host = host.trim().trim_matches('.').to_ascii_lowercase();
    match psl::domain_str(&host) {
        Some(domain) if !domain.is_empty() => domain.to_string(),
        _ => host,
    }
}

fn resolve_https_url(base: &Url, raw: &str) -> Option<String> {
    let url = base.join(raw.trim()).ok()?;
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {
        return None;
    }
    url.host_str()?;
    Some(url.to_string())
}

fn largest_declared_size(sizes: Option<&str>) -> u32 {
    sizes
        .unwrap_or("")
        .split_ascii_whitespace()
        .filter_map(|token| {
            let (width, height) = token.split_once('x')?;
            let width = width.trim().parse::<u32>().ok()?;
            let height = height.trim().parse::<u32>().ok()?;
            Some(width.min(height))
        })
        .max()
        .unwrap_or(0)
}

fn url_stays_on_domain(url: &Url, domain: &str) -> bool {
    let Some(host) = url.host_str() else {
        return false;
    };
    registrable_domain(&host.to_ascii_lowercase()) == domain
}

/// 按「svg → apple-touch-icon → 声明尺寸（大到小）→ 文档顺序」排序并去重。
///
/// 只保留仍在该注册域上的候选：厂商页面若把图标放在第三方 CDN，
/// 宁可回落到 `/favicon.ico`，也不把用户配置了哪些 MCP 厂商发给第三方。
fn extract_site_icon_urls(base: &Url, html: &str, domain: &str) -> Vec<String> {
    let document = Html::parse_document(html);
    let selector = Selector::parse("link").expect("static link selector");
    let mut candidates: Vec<SiteIconCandidate> = Vec::new();
    for (order, element) in document.select(&selector).enumerate() {
        let attrs = element.value();
        let rel = attrs.attr("rel").unwrap_or("").to_ascii_lowercase();
        let tokens: Vec<&str> = rel.split_ascii_whitespace().collect();
        let apple_touch = tokens
            .iter()
            .any(|token| token.starts_with("apple-touch-icon"));
        let has_icon = tokens.contains(&"icon");
        if !has_icon && !apple_touch {
            continue;
        }
        let Some(href) = attrs.attr("href") else {
            continue;
        };
        let Some(url) = resolve_https_url(base, href) else {
            continue;
        };
        let Ok(parsed) = Url::parse(&url) else {
            continue;
        };
        if !url_stays_on_domain(&parsed, domain) {
            continue;
        }
        candidates.push(SiteIconCandidate {
            url,
            apple_touch,
            svg: attrs
                .attr("type")
                .is_some_and(|value| value.to_ascii_lowercase().contains("svg")),
            size: largest_declared_size(attrs.attr("sizes")),
            order,
        });
    }
    candidates.sort_by_key(|candidate| {
        (
            !candidate.svg,
            !candidate.apple_touch,
            std::cmp::Reverse(candidate.size),
            candidate.order,
        )
    });
    let mut seen = HashSet::new();
    candidates
        .into_iter()
        .filter(|candidate| seen.insert(candidate.url.clone()))
        .map(|candidate| candidate.url)
        .collect()
}

/// 有些站点把 SVG 当 `image/x-icon` 或直接给二进制流，因此既看声明也嗅探正文。
fn looks_like_svg(content_type: Option<&str>, bytes: &[u8]) -> bool {
    if content_type.is_some_and(|value| value.to_ascii_lowercase().contains("svg")) {
        return true;
    }
    let body = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
    let head_len = body.len().min(512);
    let head = String::from_utf8_lossy(&body[..head_len]).to_ascii_lowercase();
    let head = head.trim_start();
    head.starts_with("<svg") || (head.starts_with("<?xml") && head.contains("<svg"))
}

fn decode_icon_image(bytes: &[u8]) -> Option<DynamicImage> {
    let mut limits = Limits::default();
    limits.max_image_width = Some(ICON_DECODE_MAX_DIMENSION);
    limits.max_image_height = Some(ICON_DECODE_MAX_DIMENSION);
    limits.max_alloc = Some(ICON_DECODE_MAX_ALLOC);

    // 先只读头部拿尺寸，超过像素上限就不解码，防「小文件、巨尺寸」的图标炸弹。
    let mut dimensions_reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .ok()?;
    dimensions_reader.limits(limits.clone());
    let (width, height) = dimensions_reader.into_dimensions().ok()?;
    let pixels = u64::from(width).saturating_mul(u64::from(height));
    if pixels == 0 || pixels > ICON_DECODE_MAX_PIXELS {
        return None;
    }

    let mut decode_reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .ok()?;
    decode_reader.limits(limits);
    decode_reader.decode().ok()
}

fn encode_png_fitted(image: &DynamicImage) -> Option<Vec<u8>> {
    // 只缩不放：小图标保持原尺寸，避免把 16×16 放大成像素块、平白增大 data URL。
    // `resize` 等比缩放并保留 RGBA 透明通道。
    let fitted = if image.width() > ICON_MAX_EDGE || image.height() > ICON_MAX_EDGE {
        image.resize(ICON_MAX_EDGE, ICON_MAX_EDGE, FilterType::Triangle)
    } else {
        image.clone()
    };
    let mut png = Cursor::new(Vec::new());
    fitted.write_to(&mut png, ImageFormat::Png).ok()?;
    Some(png.into_inner())
}

fn png_data_url_from_icon(bytes: &[u8]) -> Option<String> {
    let image = decode_icon_image(bytes)?;
    let png = encode_png_fitted(&image)?;
    Some(format!("data:image/png;base64,{}", BASE64.encode(png)))
}

/// SVG 原样保留（矢量在任何尺寸都清晰），位图统一缩到最长边 ≤64 px 的 PNG。
fn icon_data_url(content_type: Option<&str>, bytes: &[u8]) -> Option<String> {
    if bytes.is_empty() {
        return None;
    }
    if looks_like_svg(content_type, bytes) {
        if bytes.len() > SVG_MAX_BYTES {
            return None;
        }
        return Some(format!(
            "data:image/svg+xml;base64,{}",
            BASE64.encode(bytes)
        ));
    }
    png_data_url_from_icon(bytes)
}

fn cache_ttl(entry: &CacheEntry) -> u64 {
    if entry.data_url.is_some() {
        SUCCESS_TTL_SECS
    } else {
        NONE_TTL_SECS
    }
}

fn cache_is_fresh(entry: &CacheEntry, now: u64) -> bool {
    now.saturating_sub(entry.fetched_at) < cache_ttl(entry)
}

fn short_hash(value: &str) -> String {
    let digest = Sha256::digest(value.as_bytes());
    digest
        .iter()
        .take(20)
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn cache_path_for(domain: &str) -> PathBuf {
    paths::mcp_icons_dir().join(format!("{}.json", short_hash(domain)))
}

fn read_cache(path: &Path) -> Option<CacheEntry> {
    let raw = fs::read_to_string(path).ok()?;
    let entry: CacheEntry = serde_json::from_str(&raw).ok()?;
    entry.is_sane().then_some(entry)
}

fn write_cache(path: &Path, entry: &CacheEntry) {
    let Some(parent) = path.parent() else {
        return;
    };
    if fs::create_dir_all(parent).is_err() {
        return;
    }
    let Ok(raw) = serde_json::to_vec(entry) else {
        return;
    };
    let tmp = path.with_extension("json.partial");
    if fs::write(&tmp, raw).is_err() {
        return;
    }
    if fs::rename(&tmp, path).is_err() {
        let _ = fs::remove_file(&tmp);
    }
}

fn unix_now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0)
}

fn is_html_content_type(content_type: Option<&str>) -> bool {
    content_type
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .eq_ignore_ascii_case("text/html")
}

fn vendor_policy(domain: &str) -> OriginPolicy {
    OriginPolicy::SameRegistrableDomain {
        domain: domain.to_string(),
    }
}

/// 站点声明取不到时的回落顺序：注册域 `/favicon.ico` → 原始主机 `/favicon.ico`。
fn fallback_icon_candidates(target: &IconTarget) -> Vec<(String, McpIconSource)> {
    let mut out = vec![(
        format!("https://{}/favicon.ico", target.domain),
        McpIconSource::Favicon,
    )];
    if target.host != target.domain {
        out.push((
            format!("https://{}/favicon.ico", target.host),
            McpIconSource::Favicon,
        ));
    }
    out
}

async fn fetch_site_document(domain: &str) -> Option<(Url, String)> {
    let start = format!("https://{domain}/");
    let response = match skin_net::safe_https_get_browser_document_response(
        &start,
        vendor_policy(domain),
        SITE_DOC_MAX_BYTES,
    )
    .await
    {
        Ok(response) => response,
        Err(error) => {
            // 取不到站点文档是常见情况（无页面、403、超时），只记域名，不记 Target。
            tracing::debug!(domain, error = %error, "mcp_icon: site document unavailable");
            return None;
        }
    };
    if !is_html_content_type(response.content_type.as_deref()) {
        return None;
    }
    // 缺 charset 的站点可能不是 UTF-8，宽松解码只影响属性文本，不影响后续 URL 校验。
    let html = String::from_utf8_lossy(&response.bytes).into_owned();
    Some((response.final_url, html))
}

async fn download_icon_data_url(url: &str, domain: &str) -> Option<String> {
    let bytes =
        match skin_net::safe_https_get(url, vendor_policy(domain), ICON_MAX_BYTES, None).await {
            Ok(bytes) => bytes,
            Err(error) => {
                // 单个候选失败属正常（404 / 非图片 / 超限），继续下一个候选。
                tracing::debug!(error = %error, "mcp_icon: candidate download skipped");
                return None;
            }
        };
    icon_data_url(None, &bytes)
}

/// 候选顺序：站点声明的图标 → 注册域 `/favicon.ico` → 原始主机 `/favicon.ico`。
/// 只有注册域根文档能提供 `<link>` 候选；MCP 子域通常没有站点页面。
async fn resolve_remote(target: &IconTarget) -> Option<(String, McpIconSource)> {
    let mut candidates: Vec<(String, McpIconSource)> = Vec::new();
    if let Some((base, html)) = fetch_site_document(&target.domain).await {
        candidates.extend(
            extract_site_icon_urls(&base, &html, &target.domain)
                .into_iter()
                .map(|url| (url, McpIconSource::Site)),
        );
    }
    candidates.extend(fallback_icon_candidates(target));

    for (url, source) in candidates {
        if let Some(data_url) = download_icon_data_url(&url, &target.domain).await {
            return Some((data_url, source));
        }
    }
    None
}

/// 过期后重取失败时的回落：只沿用真正带图标的旧条目，且标记为缓存命中。
fn stale_icon_fallback(cached: Option<CacheEntry>) -> Option<McpIconResult> {
    cached
        .filter(|entry| entry.data_url.is_some())
        .map(result_from_cache)
}

fn result_from_cache(entry: CacheEntry) -> McpIconResult {
    McpIconResult {
        data_url: entry.data_url,
        domain: Some(entry.domain),
        source: entry.source,
        from_cache: true,
    }
}

pub async fn resolve_mcp_icon(target: &str) -> McpIconResult {
    let Some(parsed) = parse_target(target) else {
        return McpIconResult::unresolved();
    };
    let path = cache_path_for(&parsed.domain);
    let now = unix_now_secs();
    let cached = read_cache(&path);
    if let Some(entry) = cached.as_ref() {
        if cache_is_fresh(entry, now) {
            return result_from_cache(entry.clone());
        }
    }

    let resolved = tokio::time::timeout(RESOLVE_TOTAL_TIMEOUT, resolve_remote(&parsed))
        .await
        .ok()
        .flatten();

    match resolved {
        Some((data_url, source)) => {
            let entry = CacheEntry {
                domain: parsed.domain.clone(),
                data_url: Some(data_url.clone()),
                source,
                fetched_at: now,
            };
            write_cache(&path, &entry);
            McpIconResult {
                data_url: Some(data_url),
                domain: Some(parsed.domain),
                source,
                from_cache: false,
            }
        }
        None => {
            // 厂商临时故障或超时不应让已有图标闪回字母徽标：沿用旧缓存，不改写时间戳。
            // 前端会把结果缓存在内存里，所以同一会话只重试一次；下次启动或 30 天后再试。
            if let Some(stale) = stale_icon_fallback(cached) {
                return stale;
            }
            let entry = CacheEntry {
                domain: parsed.domain.clone(),
                data_url: None,
                source: McpIconSource::None,
                fetched_at: now,
            };
            write_cache(&path, &entry);
            McpIconResult {
                data_url: None,
                domain: Some(parsed.domain),
                source: McpIconSource::None,
                from_cache: false,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DAY: u64 = 24 * 60 * 60;

    fn tiny_png(width: u32, height: u32) -> Vec<u8> {
        let image = DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(
            width,
            height,
            image::Rgba([12, 34, 56, 200]),
        ));
        let mut png = Cursor::new(Vec::new());
        image
            .write_to(&mut png, ImageFormat::Png)
            .expect("encode png");
        png.into_inner()
    }

    fn cached_entry(data_url: Option<&str>, fetched_at: u64) -> CacheEntry {
        CacheEntry {
            domain: "context7.com".into(),
            data_url: data_url.map(str::to_string),
            source: if data_url.is_some() {
                McpIconSource::Site
            } else {
                McpIconSource::None
            },
            fetched_at,
        }
    }

    #[test]
    fn registrable_domain_strips_subdomains_and_keeps_private_suffixes() {
        assert_eq!(registrable_domain("mcp.context7.com"), "context7.com");
        assert_eq!(registrable_domain("context7.com"), "context7.com");
        assert_eq!(registrable_domain("API.Context7.COM"), "context7.com");
        // github.io 在 PSL 里是私有后缀，注册域必须保留用户段。
        assert_eq!(registrable_domain("foo.github.io"), "foo.github.io");
        assert_eq!(registrable_domain("api.foo.github.io"), "foo.github.io");
        assert_eq!(registrable_domain("localhost"), "localhost");
    }

    #[test]
    fn parse_target_accepts_remote_https_and_drops_query() {
        let target =
            parse_target("https://mcp.context7.com/mcp?token=secret#frag").expect("valid target");
        assert_eq!(target.host, "mcp.context7.com");
        assert_eq!(target.domain, "context7.com");

        let bare = parse_target("https://example.com.").expect("trailing dot host");
        assert_eq!(bare.host, "example.com");
    }

    #[test]
    fn parse_target_rejects_http_userinfo_local_and_no_dot_hosts() {
        for bad in [
            "http://mcp.context7.com/mcp",
            "ftp://mcp.context7.com/mcp",
            "https://user:pass@mcp.context7.com/mcp",
            "https://localhost/mcp",
            "https://app.localhost/mcp",
            "https://printer.local/mcp",
            "https://intranet/mcp",
            "https://127.0.0.1/mcp",
            "https://10.0.0.5/mcp",
            "https://[::1]/mcp",
            // 主机名本身就是公共后缀：域策略没有可限制的范围
            "https://github.io/mcp",
            "https://co.uk/mcp",
            "not a url",
            "",
        ] {
            assert!(parse_target(bad).is_none(), "must reject {bad}");
        }
    }

    #[test]
    fn fallback_candidates_try_the_domain_before_the_original_host() {
        let target = parse_target("https://mcp.context7.com/mcp").expect("valid target");
        assert_eq!(
            fallback_icon_candidates(&target),
            vec![
                (
                    "https://context7.com/favicon.ico".to_string(),
                    McpIconSource::Favicon
                ),
                (
                    "https://mcp.context7.com/favicon.ico".to_string(),
                    McpIconSource::Favicon
                ),
            ]
        );

        let bare = parse_target("https://context7.com/mcp").expect("valid target");
        assert_eq!(fallback_icon_candidates(&bare).len(), 1);
    }

    #[test]
    fn extract_site_icons_ranks_svg_apple_size_then_document_order() {
        let base = Url::parse("https://context7.com/").expect("base url");
        let html = r#"
          <html><head>
            <link rel="icon" href="/favicon-16.png" sizes="16x16">
            <link rel="shortcut icon" href="/favicon-32.png" sizes="32x32">
            <link rel="icon" type="image/svg+xml" href="/logo.svg">
            <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">
            <link rel="apple-touch-icon-precomposed" sizes="120x120" href="/apple-120.png">
            <link rel="mask-icon" href="/mask.svg">
            <link rel="icon" href="http://insecure.example.com/i.png">
            <link rel="icon" href="https://user:pass@example.com/i.png">
            <link rel="icon" href="https://third-party-cdn.example.com/i.png">
          </head></html>
        "#;
        let urls = extract_site_icon_urls(&base, html, "context7.com");
        assert_eq!(
            urls,
            vec![
                "https://context7.com/logo.svg",
                "https://context7.com/apple-touch-icon.png",
                "https://context7.com/apple-120.png",
                "https://context7.com/favicon-32.png",
                "https://context7.com/favicon-16.png",
            ]
        );
    }

    #[test]
    fn extract_site_icons_resolves_relative_urls_and_dedupes() {
        let base = Url::parse("https://docs.context7.com/guide/start").expect("base url");
        let html = r#"
            <link rel="icon" href="./assets/favicon.png">
            <link rel="icon" href="assets/favicon.png">
            <link rel="icon" href="//cdn.context7.com/icon.png">
        "#;
        let urls = extract_site_icon_urls(&base, html, "context7.com");
        assert_eq!(
            urls,
            vec![
                "https://docs.context7.com/guide/assets/favicon.png",
                "https://cdn.context7.com/icon.png",
            ]
        );
    }

    #[test]
    fn extract_site_icons_drops_other_vendors() {
        let base = Url::parse("https://foo.github.io/").expect("base url");
        let html = r#"
            <link rel="icon" href="https://foo.github.io/icon.png">
            <link rel="icon" href="https://bar.github.io/icon.png">
        "#;
        assert_eq!(
            extract_site_icon_urls(&base, html, "foo.github.io"),
            vec!["https://foo.github.io/icon.png"]
        );
    }

    #[test]
    fn stale_fallback_keeps_only_entries_that_hold_an_icon() {
        let now = 10 * SUCCESS_TTL_SECS;
        let stale = cached_entry(Some("data:image/png;base64,AAAA"), now - 90 * DAY);
        let resolved = stale_icon_fallback(Some(stale)).expect("stale icon");
        assert!(resolved.from_cache);
        assert!(resolved.data_url.is_some());
        assert_eq!(resolved.domain.as_deref(), Some("context7.com"));

        assert!(stale_icon_fallback(Some(cached_entry(None, now - 90 * DAY))).is_none());
        assert!(stale_icon_fallback(None).is_none());
    }

    #[test]
    fn cache_freshness_uses_success_and_failure_ttls() {
        let now = 10 * SUCCESS_TTL_SECS;
        let icon = "data:image/png;base64,AAAA";
        assert!(cache_is_fresh(
            &cached_entry(Some(icon), now - 29 * DAY),
            now
        ));
        assert!(!cache_is_fresh(
            &cached_entry(Some(icon), now - 31 * DAY),
            now
        ));
        assert!(cache_is_fresh(&cached_entry(None, now - 6 * DAY), now));
        assert!(!cache_is_fresh(&cached_entry(None, now - 8 * DAY), now));
    }

    #[test]
    fn cache_window_is_half_open_at_the_ttl_boundary() {
        let now = 1_000 * DAY;
        let icon = "data:image/png;base64,AAAA";
        assert!(cache_is_fresh(
            &cached_entry(Some(icon), now - SUCCESS_TTL_SECS + 1),
            now
        ));
        assert!(!cache_is_fresh(
            &cached_entry(Some(icon), now - SUCCESS_TTL_SECS),
            now
        ));
        assert!(!cache_is_fresh(
            &cached_entry(None, now - NONE_TTL_SECS),
            now
        ));
    }

    #[test]
    fn cache_entries_reject_mismatched_or_foreign_payloads() {
        assert!(cached_entry(Some("data:image/png;base64,AAAA"), 0).is_sane());
        assert!(cached_entry(None, 0).is_sane());

        let mut mismatched = cached_entry(None, 0);
        mismatched.source = McpIconSource::Site;
        assert!(!mismatched.is_sane());

        let mut script = cached_entry(None, 0);
        script.data_url = Some("javascript:alert(1)".into());
        script.source = McpIconSource::Site;
        assert!(!script.is_sane());

        let mut bad_domain = cached_entry(None, 0);
        bad_domain.domain = "../escape".into();
        assert!(!bad_domain.is_sane());
    }

    #[test]
    fn cache_file_names_are_hashed_without_leaking_domain() {
        let name = short_hash("mcp.context7.com");
        assert_eq!(name.len(), 40);
        assert!(name.chars().all(|c| c.is_ascii_hexdigit()));
        assert!(!name.contains("context7"));
        assert_ne!(short_hash("a.com"), short_hash("b.com"));
    }

    #[test]
    fn tiny_png_becomes_png_data_url_with_alpha() {
        let data_url = icon_data_url(None, &tiny_png(16, 16)).expect("png accepted");
        let encoded = data_url
            .strip_prefix("data:image/png;base64,")
            .expect("png prefix");
        let bytes = BASE64.decode(encoded).expect("valid base64");
        let image = image::load_from_memory(&bytes).expect("decode png");
        assert_eq!((image.width(), image.height()), (16, 16));
        assert!(image.color().has_alpha());
    }

    #[test]
    fn oversized_bitmap_is_fitted_into_sixty_four_pixels() {
        let data_url = icon_data_url(None, &tiny_png(256, 128)).expect("png accepted");
        let encoded = data_url
            .strip_prefix("data:image/png;base64,")
            .expect("png prefix");
        let bytes = BASE64.decode(encoded).expect("valid base64");
        let image = image::load_from_memory(&bytes).expect("decode png");
        assert_eq!((image.width(), image.height()), (64, 32));
    }

    #[test]
    fn svg_payload_is_returned_verbatim() {
        let svg = br#"<?xml version="1.0" encoding="UTF-8"?>
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle r="32"/></svg>"#;
        let data_url = icon_data_url(None, svg).expect("svg accepted");
        let encoded = data_url
            .strip_prefix("data:image/svg+xml;base64,")
            .expect("svg prefix");
        assert_eq!(BASE64.decode(encoded).expect("valid base64"), svg);

        let declared = icon_data_url(Some("image/svg+xml; charset=utf-8"), b"<svg/>")
            .expect("content type carries svg");
        assert!(declared.starts_with("data:image/svg+xml;base64,"));
    }

    #[test]
    fn undecodable_and_empty_payloads_are_skipped() {
        assert!(icon_data_url(None, b"").is_none());
        assert!(icon_data_url(None, b"not an image").is_none());
        let oversized_svg = format!("<svg>{}</svg>", "x".repeat(SVG_MAX_BYTES));
        assert!(icon_data_url(None, oversized_svg.as_bytes()).is_none());
    }

    #[test]
    fn html_content_type_only_accepts_text_html() {
        assert!(is_html_content_type(Some("text/html; charset=utf-8")));
        assert!(!is_html_content_type(Some("application/json")));
        assert!(!is_html_content_type(Some("image/png")));
        assert!(!is_html_content_type(None));
    }

    #[test]
    fn invalid_target_never_reports_a_domain() {
        let result = McpIconResult::unresolved();
        assert_eq!(result.source, McpIconSource::None);
        assert!(result.domain.is_none());
        assert!(result.data_url.is_none());
        assert!(!result.from_cache);
    }

    #[test]
    fn cache_round_trip_keeps_only_the_domain_and_icon() {
        let dir = std::env::temp_dir().join(format!(
            "grok-mcp-icon-cache-{}-{}",
            std::process::id(),
            unix_now_secs()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("temp dir");
        let path = dir.join("entry.json");
        let data_url = icon_data_url(None, &tiny_png(8, 8)).expect("png accepted");
        let entry = CacheEntry {
            domain: "context7.com".into(),
            data_url: Some(data_url.clone()),
            source: McpIconSource::Site,
            fetched_at: 42,
        };
        write_cache(&path, &entry);

        let raw = fs::read_to_string(&path).expect("cache file");
        assert!(!raw.contains("https://mcp.context7.com"));
        let loaded = read_cache(&path).expect("cache entry");
        assert_eq!(loaded.domain, "context7.com");
        assert_eq!(loaded.data_url.as_deref(), Some(data_url.as_str()));
        assert_eq!(loaded.source, McpIconSource::Site);
        assert_eq!(loaded.fetched_at, 42);
        let _ = fs::remove_dir_all(&dir);
    }
}
