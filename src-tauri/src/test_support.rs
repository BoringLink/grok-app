//! 测试隔离助手：为每个用例提供临时的 `GROK_APP_HOME`。
//!
//! 进程级环境变量是全局状态，用例结束必须恢复原值；无条件 `remove_var`
//! 会让同一测试二进制内后续用例解析到真实数据根并改写用户配置。
//! `TestAppHome` 在 Drop 时恢复原值，即使用例 panic 也不会泄漏。

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::{MutexGuard, PoisonError};

use crate::paths::APP_HOME_ENV_LOCK;

/// 独占 `APP_HOME_ENV_LOCK` 的临时 app home，Drop 时恢复 `GROK_APP_HOME`。
pub(crate) struct TestAppHome {
    // Drop 体在持锁状态下完成 env 恢复与目录清理；`_lock` 最后释放。
    _lock: MutexGuard<'static, ()>,
    previous: Option<OsString>,
    path: PathBuf,
}

impl TestAppHome {
    /// 创建并初始化一个隔离的 app home，同时把 `GROK_APP_HOME` 指向它。
    pub(crate) fn new(label: &str) -> Self {
        let lock = APP_HOME_ENV_LOCK
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let path = std::env::temp_dir().join(format!(
            "grok-app-{label}-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).expect("create isolated app home");
        let previous = std::env::var_os("GROK_APP_HOME");
        std::env::set_var("GROK_APP_HOME", &path);
        let _ = crate::paths::ensure_app_dirs();
        Self {
            _lock: lock,
            previous,
            path,
        }
    }

    pub(crate) fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TestAppHome {
    fn drop(&mut self) {
        match self.previous.take() {
            Some(value) => std::env::set_var("GROK_APP_HOME", value),
            None => std::env::remove_var("GROK_APP_HOME"),
        }
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

/// 在隔离 app home 内执行闭包。
pub(crate) fn with_temp_app_home<R>(label: &str, f: impl FnOnce(&Path) -> R) -> R {
    let home = TestAppHome::new(label);
    f(home.path())
}
