//! Report macOS window occlusion to the chat viewport controller.
//!
//! The transcript only judges its invariant on drawn frames. A window that is
//! completely covered by another app stops painting (WebKit drops the display
//! link), yet the web layer still sees `document.hidden == false` and a valid
//! client height — so neither `visibilitychange` nor focus fires and the
//! covered case has no restore boundary. The glossary defines occlusion as the
//! window being hidden **or completely covered**, and the Spec's Problem
//! Statement records covering the window with another app and coming back as a
//! source of a wrong position.
//!
//! On macOS `NSWindowDidChangeOcclusionStateNotification` is that signal. We
//! observe it on the main window and emit `chat-viewport://occlusion`, which
//! the controller turns into the same restore boundary it uses for a hidden
//! window. The module is macOS-only; Windows and Linux keep the web signals.

#![cfg(target_os = "macos")]

use objc2::runtime::AnyObject;
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

/// Host → frontend when the main window's occlusion state changes.
pub const CHAT_VIEWPORT_OCCLUSION_EVENT: &str = "chat-viewport://occlusion";

/// `NSWindowOcclusionStateVisible` (`1 << 1`). Any state without this bit means
/// the window is completely covered or off-screen, so the engine has stopped
/// painting it.
pub const NS_WINDOW_OCCLUSION_STATE_VISIBLE: u64 = 1 << 1;

/// Whether an `NSWindowOcclusionState` bitmask means "the window is drawing".
/// Pure, so the bit test is covered without a live NSWindow.
pub fn visible_from_occlusion_state(state: u64) -> bool {
    state & NS_WINDOW_OCCLUSION_STATE_VISIBLE != 0
}

/// Install the occlusion observer on the main window. Safe to call once the
/// window exists (after `show`); failures are logged, not fatal — the client
/// then simply has no covered-window signal.
pub fn install(window: &WebviewWindow) {
    let Ok(ns_window) = window.ns_window() else {
        tracing::warn!("chat_viewport_occlusion: no NSWindow yet; covered-window signal disabled");
        return;
    };
    if ns_window.is_null() {
        return;
    }
    // SAFETY: `ns_window` is the live NSWindow of the main WebView, and this
    // runs on the main thread (setup / run_on_main_thread after show).
    unsafe { register_observer(ns_window as *mut AnyObject, window.app_handle().clone()) };
    tracing::info!("chat_viewport_occlusion: NSWindow occlusion observer installed");
}

/// Register for `NSWindowDidChangeOcclusionStateNotification` on `ns_window`.
///
/// # Safety
/// `ns_window` must be a valid, live NSWindow pointer and the caller must be on
/// the main thread.
unsafe fn register_observer(ns_window: *mut AnyObject, app: AppHandle) {
    use block2::RcBlock;
    use objc2::{class, msg_send};

    // The notification name's string value is its own symbol name, so it can be
    // built directly and avoids an objc2-app-kit dependency.
    let name: *mut AnyObject = msg_send![
        class!(NSString),
        stringWithUTF8String: c"NSWindowDidChangeOcclusionStateNotification".as_ptr()
    ];
    let center: *mut AnyObject = msg_send![class!(NSNotificationCenter), defaultCenter];
    if name.is_null() || center.is_null() {
        return;
    }

    // Emit the current state once so the client starts in sync even if the
    // window is already occluded at install time.
    emit_occlusion(&app, ns_window);

    let block = RcBlock::new(move |_note: *mut AnyObject| {
        // SAFETY: the app handle outlives the process; the window pointer was
        // validated by `install` and the observation lives for the process.
        unsafe { emit_occlusion(&app, ns_window) };
    });
    let _observer: *mut AnyObject = msg_send![
        center,
        addObserverForName: name,
        object: ns_window,
        queue: std::ptr::null_mut::<AnyObject>(),
        usingBlock: &*block
    ];
    // The observation lives for the whole process; leaking the block keeps the
    // notification center's copy valid. Mirrors `mac_ime_fn_bridge`.
    std::mem::forget(block);
}

/// Read `occlusionState` and publish it. The notification center retains the
/// block, so it must be read on the main thread.
///
/// # Safety
/// `ns_window` must be a valid, live NSWindow pointer.
unsafe fn emit_occlusion(app: &AppHandle, ns_window: *mut AnyObject) {
    use objc2::msg_send;
    let state: u64 = msg_send![ns_window, occlusionState];
    let occluded = !visible_from_occlusion_state(state);
    let _ = app.emit(
        CHAT_VIEWPORT_OCCLUSION_EVENT,
        serde_json::json!({ "occluded": occluded }),
    );
}

#[cfg(test)]
mod tests {
    use super::{visible_from_occlusion_state, NS_WINDOW_OCCLUSION_STATE_VISIBLE};

    #[test]
    fn visible_bit_marks_a_drawing_window() {
        assert!(visible_from_occlusion_state(
            NS_WINDOW_OCCLUSION_STATE_VISIBLE
        ));
        // Other flags alongside Visible still count as drawing.
        assert!(visible_from_occlusion_state(
            NS_WINDOW_OCCLUSION_STATE_VISIBLE | 0b100
        ));
    }

    #[test]
    fn missing_visible_bit_means_occluded() {
        assert!(!visible_from_occlusion_state(0));
        assert!(!visible_from_occlusion_state(0b1));
        assert!(!visible_from_occlusion_state(0b100));
    }
}
