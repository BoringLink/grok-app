//! Recreate a Windows WebView2 window after the browser process dies.
//!
//! Issue #1385: the browser process OOMs inside WebView2 (PartitionAlloc,
//! exception `0xE0000008`). Tauri leaves the HWND up with a blank client area
//! and a flood of `0x8007139F`. `ICoreWebView2::ProcessFailed` is the supported
//! signal. A dead browser process cannot `Reload`; the window has to be
//! destroyed and built again. Renderer exit / unresponsive tries `Reload` first.
//!
//! `Window::destroy` skips `CloseRequested`, so close-to-tray does not swallow
//! the rebuild. Destroying the last window still emits `RunEvent::ExitRequested`.
//! [`should_block_exit`] prevents that exit while a rebuild is in flight.
//! Real quits (`app.exit(code)`) carry `Some(code)` and are not blocked.

#![cfg(windows)]

use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

use tauri::{AppHandle, Manager, Theme, WebviewUrl, WebviewWindow};
use webview2_com::{
    Microsoft::Web::WebView2::Win32::{
        ICoreWebView2, ICoreWebView2ProcessFailedEventArgs, ICoreWebView2ProcessFailedEventArgs2,
        ICoreWebView2ProcessFailedEventHandler, COREWEBVIEW2_PROCESS_FAILED_KIND,
        COREWEBVIEW2_PROCESS_FAILED_REASON,
    },
    ProcessFailedEventHandler,
};
use windows::core::Interface;

use crate::webview_recovery::{
    action_for, blocks_exit_for_rebuild, classify_kind, logical_px, logical_signed_px,
    recovery_log_line, restored_url, BudgetDecision, RecoveryAction, RecoveryBudget, RestoredUrl,
};

static HOLD: AtomicUsize = AtomicUsize::new(0);
static BUDGETS: Mutex<Option<HashMap<String, RecoveryBudget>>> = Mutex::new(None);
static PENDING: Mutex<Option<HashMap<String, Option<WindowSnapshot>>>> = Mutex::new(None);

thread_local! {
    static HANDLERS: RefCell<Vec<ICoreWebView2ProcessFailedEventHandler>> =
        const { RefCell::new(Vec::new()) };
    static INSTALLED: RefCell<HashMap<String, usize>> = RefCell::new(HashMap::new());
}

#[derive(Clone)]
struct WindowSnapshot {
    url: Option<String>,
    title: String,
    x: Option<f64>,
    y: Option<f64>,
    width: f64,
    height: f64,
    maximized: bool,
    fullscreen: bool,
    visible: bool,
    decorations: bool,
    resizable: bool,
    always_on_top: bool,
}

/// `true` when a rebuild has destroyed a window and the process must stay up.
/// Programmatic exit (`Some(code)`, including tray Quit) is never blocked.
pub fn should_block_exit(code: Option<i32>) -> bool {
    blocks_exit_for_rebuild(code, HOLD.load(Ordering::SeqCst))
}

/// Hook `ProcessFailed` once per live `ICoreWebView2`. Page loads call this
/// again; the COM pointer keeps the second call from stacking handlers.
pub fn install(webview: &tauri::Webview) {
    let window_label = webview.window().label().to_string();
    let webview_label = webview.label().to_string();
    let app = webview.app_handle().clone();
    let hooked = webview_label.clone();
    if let Err(error) = webview.with_webview(move |platform| {
        attach(platform, app, window_label, hooked);
    }) {
        tracing::warn!(
            target: "webview_recovery",
            %error,
            %webview_label,
            "webview recovery: with_webview failed; will retry on the next load"
        );
    }
}

/// The HWND is gone. Build the replacement on a later event-loop turn.
/// Creating it inside this callback re-enters wry's window map borrow.
pub fn on_window_destroyed(app: &AppHandle, label: &str) {
    if !is_pending(label) {
        return;
    }
    let snap = take_snapshot(label);
    let app = app.clone();
    let label_for_task = label.to_string();
    let label_for_hop = label_for_task.clone();
    let label_for_fail = label_for_task.clone();
    if !hop_main(app.clone(), label_for_hop, move || {
        rebuild_now(&app, &label_for_task, snap);
    }) {
        emit(&format!(
            "label={label_for_fail} action=recreate_failed detail=main_thread_hop"
        ));
        finish(&label_for_fail);
    }
}

fn attach(
    platform: tauri::webview::PlatformWebview,
    app: AppHandle,
    window_label: String,
    webview_label: String,
) {
    let core = match unsafe { platform.controller().CoreWebView2() } {
        Ok(core) => core,
        Err(error) => {
            tracing::warn!(
                target: "webview_recovery",
                %error,
                %webview_label,
                "webview recovery: CoreWebView2 unavailable"
            );
            return;
        }
    };
    let ptr = core.as_raw() as usize;
    let already =
        INSTALLED.with(|installed| installed.borrow().get(&webview_label).copied() == Some(ptr));
    if already {
        return;
    }

    let handler = ProcessFailedEventHandler::create(Box::new(move |sender, args| {
        on_process_failed(&app, &window_label, sender, args);
        Ok(())
    }));
    let mut token = 0i64;
    if let Err(error) = unsafe { core.add_ProcessFailed(&handler, &mut token) } {
        tracing::warn!(
            target: "webview_recovery",
            %error,
            %webview_label,
            "webview recovery: add_ProcessFailed failed"
        );
        return;
    }
    INSTALLED.with(|installed| {
        installed.borrow_mut().insert(webview_label, ptr);
    });
    HANDLERS.with(|handlers| handlers.borrow_mut().push(handler));
}

fn on_process_failed(
    app: &AppHandle,
    window_label: &str,
    sender: Option<ICoreWebView2>,
    args: Option<ICoreWebView2ProcessFailedEventArgs>,
) {
    let Some(args) = args else {
        emit(&format!(
            "label={window_label} kind=unknown action=log_only detail=missing_args"
        ));
        return;
    };
    let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND(0);
    if let Err(error) = unsafe { args.ProcessFailedKind(&mut kind) } {
        emit(&format!(
            "label={window_label} action=log_only detail=kind_query_failed error={error}"
        ));
        return;
    }
    let (exit_code, reason) = failure_details(&args);
    let classified = classify_kind(kind.0);
    let requested = action_for(classified);

    if requested == RecoveryAction::LogOnly {
        emit(&recovery_log_line(
            window_label,
            classified,
            requested,
            BudgetDecision::Allowed { count: 0 },
            exit_code,
            reason,
        ));
        return;
    }

    // A rebuild already owns this window. Do not Reload a dying control and
    // do not spend another budget slot on the same crash.
    if is_pending(window_label) {
        emit(&format!(
            "label={window_label} kind={} action=already_pending",
            classified.as_str()
        ));
        return;
    }

    let decision = acquire(window_label);
    emit(&recovery_log_line(
        window_label,
        classified,
        requested,
        decision,
        exit_code,
        reason,
    ));
    if !matches!(decision, BudgetDecision::Allowed { .. }) {
        return;
    }

    if requested == RecoveryAction::Reload {
        if reload_sender(sender) {
            return;
        }
        emit(&format!(
            "label={window_label} kind={} action=recreate detail=reload_failed",
            classified.as_str()
        ));
    }

    schedule_recreate(app, window_label);
}

/// `Reload` the control that raised `ProcessFailed`. Returns false when the
/// browser process is already gone so the caller can rebuild the window.
/// Calling `with_webview` from inside this callback re-enters wry.
fn reload_sender(sender: Option<ICoreWebView2>) -> bool {
    let Some(core) = sender else {
        return false;
    };
    unsafe { core.Reload().is_ok() }
}

fn failure_details(args: &ICoreWebView2ProcessFailedEventArgs) -> (Option<i32>, Option<i32>) {
    let Ok(args2) = args.cast::<ICoreWebView2ProcessFailedEventArgs2>() else {
        return (None, None);
    };
    let mut exit_code = 0i32;
    let exit_code = unsafe { args2.ExitCode(&mut exit_code) }
        .ok()
        .map(|_| exit_code);
    let mut reason = COREWEBVIEW2_PROCESS_FAILED_REASON(0);
    let reason = unsafe { args2.Reason(&mut reason) }.ok().map(|_| reason.0);
    (exit_code, reason)
}

fn schedule_recreate(app: &AppHandle, label: &str) {
    if !try_begin(label) {
        emit(&format!("label={label} action=already_pending"));
        return;
    }
    let app = app.clone();
    let label_owned = label.to_string();
    let label_for_fail = label_owned.clone();
    let label_for_hop = label_owned.clone();
    if !hop_main(app.clone(), label_for_hop, move || {
        begin_destroy(&app, &label_owned);
    }) {
        emit(&format!(
            "label={label_for_fail} action=recreate_failed detail=main_thread_hop"
        ));
        finish(&label_for_fail);
    }
}

fn begin_destroy(app: &AppHandle, label: &str) {
    if label == "main" {
        use tauri_plugin_window_state::{AppHandleExt, StateFlags};
        let flags = StateFlags::SIZE
            | StateFlags::POSITION
            | StateFlags::MAXIMIZED
            | StateFlags::FULLSCREEN;
        if let Err(error) = app.save_window_state(flags) {
            tracing::warn!(
                target: "webview_recovery",
                %error,
                "webview recovery: save main geometry before rebuild failed"
            );
        }
    }
    let Some(window) = app.get_webview_window(label) else {
        rebuild_now(app, label, None);
        return;
    };
    store_snapshot(label, snapshot_window(&window));
    // `destroy` does not emit CloseRequested, so close-to-tray cannot hide
    // the dead window instead of dropping it. ExitRequested is blocked by HOLD.
    if let Err(error) = window.destroy() {
        emit(&format!(
            "label={label} action=recreate_failed detail=destroy error={error}"
        ));
        finish(label);
    }
}

fn rebuild_now(app: &AppHandle, label: &str, snap: Option<WindowSnapshot>) {
    let result = dispatch_rebuild(app, label, snap.as_ref());
    if let Err(error) = result {
        emit(&format!(
            "label={label} action=recreate_failed detail={error}"
        ));
    } else {
        emit(&format!("label={label} action=recreate_done"));
    }
    finish(label);
}

fn dispatch_rebuild(
    app: &AppHandle,
    label: &str,
    snap: Option<&WindowSnapshot>,
) -> Result<(), String> {
    if label == crate::side_browser_google_auth::AUTH_WINDOW_LABEL {
        // The auth window's own Destroyed handler resumes the side browser.
        // Rebuilding it here would drop the navigation callback and the
        // shared cookie profile. Sign-in is restarted by the user.
        emit(&format!(
            "label={label} action=closed detail=google_auth_left_to_its_close_handler"
        ));
        return Ok(());
    }
    if label == crate::pet_window::PET_WINDOW_LABEL {
        return rebuild_pet(app, snap);
    }
    if label == crate::pet_quick::QUICK_WINDOW_LABEL {
        return rebuild_quick(app, snap);
    }
    if label == crate::theme_editor_window::THEME_EDITOR_WINDOW_LABEL {
        // The command is async only because Tauri commands are. It does not
        // await; polling it here builds the window on this (main) turn.
        return tauri::async_runtime::block_on(
            crate::theme_editor_window::open_theme_editor_window(app.clone()),
        );
    }
    if label == crate::wallpaper_grok_album::WINDOW_LABEL {
        let title = snap.map(|snap| snap.title.as_str()).unwrap_or("Grok");
        return crate::wallpaper_grok_album::reopen_after_webview_crash(app, title);
    }
    if label == "main" {
        return rebuild_main(app, snap);
    }
    rebuild_generic(app, label, snap)
}

fn rebuild_pet(app: &AppHandle, snap: Option<&WindowSnapshot>) -> Result<(), String> {
    if snap.is_none_or(|snap| snap.visible) {
        crate::pet_window::show_pet(app)
    } else {
        crate::pet_window::ensure_pet_window(app).map(|_| ())
    }
}

fn rebuild_quick(app: &AppHandle, snap: Option<&WindowSnapshot>) -> Result<(), String> {
    let window = crate::pet_quick::ensure_quick(app)?;
    if snap.is_some_and(|snap| snap.visible) {
        window.show().map_err(|error| error.to_string())?;
        let _ = window.set_focus();
    }
    Ok(())
}

fn rebuild_main(app: &AppHandle, snap: Option<&WindowSnapshot>) -> Result<(), String> {
    let mut cfg = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == "main")
        .cloned()
        .ok_or_else(|| "main window config missing".to_string())?;
    let snap = snap.cloned().unwrap_or_else(default_main_snapshot);
    apply_snapshot_to_config(&mut cfg, &snap);
    cfg.label = "main".to_string();
    cfg.visible = false;
    cfg.maximized = false;
    let script = boot_script();
    let window = tauri::WebviewWindowBuilder::from_config(app, &cfg)
        .map_err(|error| error.to_string())?
        .initialization_script(&script)
        .accept_first_mouse(true)
        .build()
        .map_err(|error| error.to_string())?;
    paint_boot_chrome(&window);
    crate::win_shell::ensure_main_window_shell_integration(&window);
    crate::win_shell::attach_webview_keyboard_focus(&window);
    if snap.maximized {
        let _ = window.maximize();
    }
    if snap.fullscreen {
        let _ = window.set_fullscreen(true);
    }
    if snap.visible {
        window.show().map_err(|error| error.to_string())?;
        let _ = window.set_focus();
        crate::win_file_drop::install_after_show(&window);
    } else {
        crate::win_shell::set_main_window_skip_taskbar(&window, true);
    }
    crate::window_min::apply_main(app);
    if let Err(error) = crate::app_menu::install(app) {
        tracing::warn!(
            target: "webview_recovery",
            %error,
            "webview recovery: menu reinstall after main rebuild failed"
        );
    }
    Ok(())
}

fn rebuild_generic(
    app: &AppHandle,
    label: &str,
    snap: Option<&WindowSnapshot>,
) -> Result<(), String> {
    let snap = snap.cloned().unwrap_or_else(default_main_snapshot);
    let url = webview_url(snap.url.as_deref());
    let mut builder = tauri::WebviewWindowBuilder::new(app, label, url)
        .title(snap.title)
        .inner_size(snap.width, snap.height)
        .resizable(snap.resizable)
        .decorations(snap.decorations)
        .always_on_top(snap.always_on_top)
        .visible(false)
        .accept_first_mouse(true);
    if let (Some(x), Some(y)) = (snap.x, snap.y) {
        builder = builder.position(x, y);
    } else {
        builder = builder.center();
    }
    let window = builder.build().map_err(|error| error.to_string())?;
    paint_boot_chrome(&window);
    crate::win_shell::attach_webview_keyboard_focus(&window);
    if snap.maximized {
        let _ = window.maximize();
    }
    if snap.fullscreen {
        let _ = window.set_fullscreen(true);
    }
    if snap.visible {
        window.show().map_err(|error| error.to_string())?;
        let _ = window.set_focus();
    }
    Ok(())
}

fn webview_url(current: Option<&str>) -> WebviewUrl {
    match restored_url(current.unwrap_or("")) {
        RestoredUrl::App(path) => WebviewUrl::App(path.into()),
        RestoredUrl::External(url) => match tauri::Url::parse(&url) {
            Ok(url) => WebviewUrl::External(url),
            Err(_) => WebviewUrl::App("index.html".into()),
        },
    }
}

fn apply_snapshot_to_config(cfg: &mut tauri::utils::config::WindowConfig, snap: &WindowSnapshot) {
    cfg.url = webview_url(snap.url.as_deref());
    cfg.width = snap.width;
    cfg.height = snap.height;
    cfg.fullscreen = snap.fullscreen;
    cfg.resizable = snap.resizable;
    cfg.decorations = snap.decorations;
    cfg.title = snap.title.clone();
    if let (Some(x), Some(y)) = (snap.x, snap.y) {
        cfg.x = Some(x);
        cfg.y = Some(y);
        cfg.center = false;
    } else {
        cfg.x = None;
        cfg.y = None;
        cfg.center = true;
    }
}

fn paint_boot_chrome(window: &WebviewWindow) {
    let light = boot_theme() == "light";
    let (red, green, blue) = if light { (244, 244, 246) } else { (13, 13, 13) };
    let _ = window.set_background_color(Some(tauri::window::Color(red, green, blue, 255)));
    let _ = window.set_theme(Some(if light { Theme::Light } else { Theme::Dark }));
}

fn boot_theme() -> &'static str {
    match crate::store::load_settings()
        .theme
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "light" => "light",
        "dark" => "dark",
        _ => {
            if crate::os_theme::os_prefers_dark() {
                "dark"
            } else {
                "light"
            }
        }
    }
}

fn boot_script() -> String {
    let settings = crate::store::load_settings();
    let theme = boot_theme();
    let locale = crate::tray_i18n::Locale::parse(&settings.locale);
    let os_lang = crate::tray_i18n::detect_os_lang_tag();
    format!(
        r#"(function(){{try{{Object.defineProperty(window,"__GROK_BOOT_THEME__",{{value:{theme:?},writable:false,configurable:false}});Object.defineProperty(window,"__GROK_BOOT_LOCALE__",{{value:{locale:?},writable:false,configurable:false}});Object.defineProperty(window,"__GROK_BOOT_OS_LANG__",{{value:{os_lang:?},writable:false,configurable:false}});var d=document.documentElement;if(d){{d.setAttribute("data-theme",{theme:?});d.setAttribute("lang",{html_lang:?});}}}}catch(e){{}}}})();"#,
        theme = theme,
        locale = locale.as_tag(),
        os_lang = os_lang,
        html_lang = locale.html_lang(),
    )
}

fn snapshot_window(window: &WebviewWindow) -> WindowSnapshot {
    let scale = window.scale_factor().unwrap_or(1.0);
    let size = window.inner_size().ok();
    let pos = window.outer_position().ok();
    WindowSnapshot {
        url: window.url().ok().map(|url| url.to_string()),
        title: window.title().unwrap_or_else(|_| "Grok".to_string()),
        x: pos.map(|pos| logical_signed_px(pos.x, scale)),
        y: pos.map(|pos| logical_signed_px(pos.y, scale)),
        width: size
            .map(|size| logical_px(size.width, scale))
            .filter(|width| *width > 1.0)
            .unwrap_or(1200.0),
        height: size
            .map(|size| logical_px(size.height, scale))
            .filter(|height| *height > 1.0)
            .unwrap_or(800.0),
        maximized: window.is_maximized().unwrap_or(false),
        fullscreen: window.is_fullscreen().unwrap_or(false),
        visible: window.is_visible().unwrap_or(true),
        decorations: window.is_decorated().unwrap_or(false),
        resizable: window.is_resizable().unwrap_or(true),
        always_on_top: window.is_always_on_top().unwrap_or(false),
    }
}

fn default_main_snapshot() -> WindowSnapshot {
    WindowSnapshot {
        url: None,
        title: "Grok".to_string(),
        x: None,
        y: None,
        width: 1200.0,
        height: 800.0,
        maximized: false,
        fullscreen: false,
        visible: true,
        decorations: false,
        resizable: true,
        always_on_top: false,
    }
}

fn hop_main<F>(app: AppHandle, label: String, task: F) -> bool
where
    F: FnOnce() + Send + 'static,
{
    // `run_on_main_thread` runs inline when already on the UI thread.
    // ProcessFailed and Destroyed both hold wry's window map, so the task
    // is posted from another thread and runs on a later turn. If that post
    // fails, release the exit hold here — the task will not call `finish`.
    std::thread::Builder::new()
        .name("webview-recovery".into())
        .spawn(move || {
            if let Err(error) = app.run_on_main_thread(task) {
                tracing::error!(
                    target: "webview_recovery",
                    %error,
                    %label,
                    "webview recovery: run_on_main_thread failed"
                );
                emit(&format!(
                    "label={label} action=recreate_failed detail=main_thread_hop"
                ));
                finish(&label);
            }
        })
        .is_ok()
}

fn emit(line: &str) {
    tracing::error!(target: "webview_recovery", "{line}");
    crate::logging::sync_diag(&format!("webview_recovery: {line}"));
}

fn acquire(label: &str) -> BudgetDecision {
    let mut guard = BUDGETS.lock().unwrap_or_else(|error| error.into_inner());
    let budgets = guard.get_or_insert_with(HashMap::new);
    let budget = budgets
        .entry(label.to_string())
        .or_insert_with(RecoveryBudget::standard);
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0);
    budget.try_acquire(now_ms)
}

fn try_begin(label: &str) -> bool {
    let mut guard = PENDING.lock().unwrap_or_else(|error| error.into_inner());
    let pending = guard.get_or_insert_with(HashMap::new);
    if pending.contains_key(label) {
        return false;
    }
    pending.insert(label.to_string(), None);
    HOLD.fetch_add(1, Ordering::SeqCst);
    true
}

fn is_pending(label: &str) -> bool {
    PENDING
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .as_ref()
        .is_some_and(|pending| pending.contains_key(label))
}

fn store_snapshot(label: &str, snap: WindowSnapshot) {
    if let Some(pending) = PENDING
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .as_mut()
    {
        if let Some(slot) = pending.get_mut(label) {
            *slot = Some(snap);
        }
    }
}

fn take_snapshot(label: &str) -> Option<WindowSnapshot> {
    PENDING
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .as_mut()
        .and_then(|pending| pending.get_mut(label))
        .and_then(|slot| slot.take())
}

fn finish(label: &str) {
    let removed = PENDING
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .as_mut()
        .is_some_and(|pending| pending.remove(label).is_some());
    if removed {
        HOLD.fetch_sub(1, Ordering::SeqCst);
    }
}

#[cfg(test)]
mod tests {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED,
        COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED,
        COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE,
    };

    #[test]
    fn com_kind_codes_match_the_pure_classifier() {
        assert_eq!(
            COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED.0,
            crate::webview_recovery::KIND_BROWSER_PROCESS_EXITED
        );
        assert_eq!(
            COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED.0,
            crate::webview_recovery::KIND_RENDER_PROCESS_EXITED
        );
        assert_eq!(
            COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE.0,
            crate::webview_recovery::KIND_RENDER_PROCESS_UNRESPONSIVE
        );
    }
}
