//! The tray icon on macOS: an item in the menu bar. AppKit needs the main
//! thread, so [`run`] takes it over.

use std::cell::RefCell;
use std::time::SystemTime;

use objc2::rc::Retained;
use objc2::runtime::{AnyObject, NSObject};
use objc2::{DefinedClass, MainThreadMarker, MainThreadOnly, define_class, msg_send, sel};
use objc2_app_kit::{
    NSApplication, NSApplicationActivationPolicy, NSImage, NSMenu, NSMenuItem, NSStatusBar,
    NSStatusItem, NSVariableStatusItemLength,
};
use objc2_foundation::{NSString, NSTimer};
use tokio::runtime::Runtime;
use tokio::sync::watch;
use tracing::warn;

use super::{
    MenuModel, OPEN_DEVICES_ITEM, QUIT_ITEM, REFRESH_INTERVAL, SHUTDOWN_WAIT, SYNC_ITEM,
    devices_url, status_text, sync_age_minutes,
};
use crate::bridge::BridgeHandle;
use crate::bridge::open_url::open_url;
use crate::bridge::state::{BridgeState, BridgeStatus};

#[derive(Debug, thiserror::Error)]
pub enum TrayError {
    #[error("the tray icon must start on the main thread")]
    NotMainThread,
}

struct Appearance {
    /// An SF Symbol for the menu bar.
    symbol: &'static str,
    /// The menu bar text, when the system does not have the symbol.
    fallback_title: &'static str,
}

fn appearance(status: BridgeStatus) -> Appearance {
    match status {
        BridgeStatus::Starting => Appearance {
            symbol: "circle.dotted",
            fallback_title: "MCP …",
        },
        BridgeStatus::Connected => Appearance {
            symbol: "checkmark.circle",
            fallback_title: "MCP ✓",
        },
        BridgeStatus::Disconnected => Appearance {
            symbol: "exclamationmark.triangle",
            fallback_title: "MCP !",
        },
        BridgeStatus::SignedOut => Appearance {
            symbol: "person.crop.circle.badge.xmark",
            fallback_title: "MCP ✗",
        },
    }
}

/// The state of the tunnel client, as the refresh timer looks at it. A look
/// makes the menu only when the state changed, or when the age of the last
/// sync in the menu is a different number of minutes now.
struct MenuWatch {
    state: watch::Receiver<BridgeState>,
    /// The age of the last sync in the menu of the last look that made one.
    /// The outer `None`: no look made a menu yet.
    shown_sync_age: Option<Option<u64>>,
}

/// What one look of a [`MenuWatch`] found.
#[derive(Debug, PartialEq, Eq)]
enum Look {
    /// The menu of the look before is still right.
    Unchanged,
    Menu(MenuModel),
    /// The tunnel client ended.
    Ended,
}

impl MenuWatch {
    fn new(state: watch::Receiver<BridgeState>) -> Self {
        Self {
            state,
            shown_sync_age: None,
        }
    }

    fn look(&mut self, now: SystemTime) -> Look {
        // The sender is gone when the tunnel client stopped (SIGTERM, Ctrl-C).
        let Ok(changed) = self.state.has_changed() else {
            return Look::Ended;
        };
        let sync_age = sync_age_minutes(self.state.borrow().sync, now);
        if !changed && self.shown_sync_age == Some(sync_age) {
            return Look::Unchanged;
        }
        self.shown_sync_age = Some(sync_age);
        Look::Menu(MenuModel::of(&self.state.borrow_and_update(), now))
    }
}

struct Ivars {
    status_item: Retained<NSStatusItem>,
    menu: Retained<NSMenu>,
    bridge: BridgeHandle,
    watch: RefCell<MenuWatch>,
    /// The address of the Device tab of Personal Settings in Archestra.
    devices_url: String,
    /// What the menu and the menu bar show now.
    shown: RefCell<Option<MenuModel>>,
    /// The runtime of the tunnel client. Quit takes it and shuts it down.
    runtime: RefCell<Option<Runtime>>,
}

define_class!(
    // SAFETY:
    // - `NSObject` has no rules for its subclasses.
    // - `MainThreadOnly`: the object holds AppKit objects and AppKit calls
    //   it on the main thread only.
    // - The class does not implement `Drop`.
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "ArchestraMcpBridgeTray"]
    #[ivars = Ivars]
    struct TrayController;

    impl TrayController {
        /// The target of the refresh timer.
        #[unsafe(method(refresh:))]
        fn refresh(&self, _timer: &NSTimer) {
            self.show();
        }

        #[unsafe(method(syncConfig:))]
        fn sync_config(&self, _sender: Option<&AnyObject>) {
            self.ivars().bridge.sync_now();
        }

        #[unsafe(method(openDevices:))]
        fn open_devices(&self, _sender: Option<&AnyObject>) {
            if !open_url(&self.ivars().devices_url) {
                warn!("could not open the Device tab in the browser");
            }
        }

        #[unsafe(method(quit:))]
        fn quit(&self, _sender: Option<&AnyObject>) {
            self.shut_down();
        }
    }
);

impl TrayController {
    fn new(mtm: MainThreadMarker, ivars: Ivars) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(ivars);
        // SAFETY: `init` of `NSObject` takes no arguments and returns the
        // initialized object.
        unsafe { msg_send![super(this), init] }
    }

    /// Brings the menu and the menu bar up to date with the state of the
    /// tunnel client. The refresh timer calls it on the main thread. The
    /// timer does not run while the menu is open, so the lines of an open
    /// menu do not change under the pointer.
    fn show(&self) {
        let ivars = self.ivars();
        // A statement of its own: the borrow of the watch ends here.
        let look = ivars.watch.borrow_mut().look(SystemTime::now());
        let model = match look {
            Look::Unchanged => return,
            Look::Menu(model) => model,
            Look::Ended => {
                self.shut_down();
                return;
            }
        };
        // A change of the state that the menu does not show draws nothing.
        let shown = ivars.shown.replace(Some(model.clone()));
        if shown.as_ref() == Some(&model) {
            return;
        }
        self.build_menu(&model);
        if shown.map(|shown| shown.status) != Some(model.status) {
            self.show_icon(model.status);
        }
    }

    /// Makes the items of the menu again, from the model.
    fn build_menu(&self, model: &MenuModel) {
        let mtm = self.mtm();
        let menu = &self.ivars().menu;
        menu.removeAllItems();
        menu.addItem(&info_item(mtm, status_text(model.status)));
        menu.addItem(&info_item(mtm, &model.config_line));
        if let Some(update_line) = &model.update_line {
            menu.addItem(&info_item(mtm, update_line));
        }
        if !model.server_lines.is_empty() {
            menu.addItem(&NSMenuItem::separatorItem(mtm));
            for line in &model.server_lines {
                menu.addItem(&info_item(mtm, line));
            }
        }
        menu.addItem(&NSMenuItem::separatorItem(mtm));
        for (title, action) in [
            (SYNC_ITEM, sel!(syncConfig:)),
            (OPEN_DEVICES_ITEM, sel!(openDevices:)),
            (QUIT_ITEM, sel!(quit:)),
        ] {
            menu.addItem(&action_item(mtm, self, title, action));
        }
    }

    fn show_icon(&self, status: BridgeStatus) {
        let appearance = appearance(status);
        let text = status_text(status);
        let Some(button) = self.ivars().status_item.button(self.mtm()) else {
            return;
        };
        let symbol = NSImage::imageWithSystemSymbolName_accessibilityDescription(
            &NSString::from_str(appearance.symbol),
            Some(&NSString::from_str(text)),
        );
        match symbol {
            Some(image) => {
                // A template image follows the light or dark menu bar.
                image.setTemplate(true);
                button.setImage(Some(&image));
                button.setTitle(&NSString::new());
            }
            None => {
                button.setImage(None);
                button.setTitle(&NSString::from_str(appearance.fallback_title));
            }
        }
    }

    /// Stops the tunnel client and its MCP servers, then ends the program.
    fn shut_down(&self) {
        if let Some(runtime) = self.ivars().runtime.borrow_mut().take() {
            runtime.shutdown_timeout(SHUTDOWN_WAIT);
        }
        NSApplication::sharedApplication(self.mtm()).terminate(None);
    }
}

/// Shows the tray icon and runs the AppKit event loop. It does not return in
/// normal operation: Quit, or the end of the tunnel client (the state of
/// `bridge` closes), ends the program. `base_url` is the address of
/// Archestra, for "Open Device tab".
pub fn run(runtime: Runtime, bridge: BridgeHandle, base_url: &str) -> Result<(), TrayError> {
    let mtm = MainThreadMarker::new().ok_or(TrayError::NotMainThread)?;
    let app = NSApplication::sharedApplication(mtm);
    // No Dock icon and no main menu: only the menu bar item.
    app.setActivationPolicy(NSApplicationActivationPolicy::Accessory);

    let status_item =
        NSStatusBar::systemStatusBar().statusItemWithLength(NSVariableStatusItemLength);
    let menu = NSMenu::new(mtm);
    // The menu does not look for a validator: an item with no action stays
    // as it is set.
    menu.setAutoenablesItems(false);
    status_item.setMenu(Some(&menu));

    let controller = TrayController::new(
        mtm,
        Ivars {
            status_item,
            menu,
            watch: RefCell::new(MenuWatch::new(bridge.state.clone())),
            bridge,
            devices_url: devices_url(base_url),
            shown: RefCell::new(None),
            runtime: RefCell::new(Some(runtime)),
        },
    );
    controller.show();
    // SAFETY: `controller` has the method `refresh:` with one `NSTimer`
    // argument, and the timer keeps a strong reference to its target.
    let _timer = unsafe {
        NSTimer::scheduledTimerWithTimeInterval_target_selector_userInfo_repeats(
            REFRESH_INTERVAL.as_secs_f64(),
            &controller,
            sel!(refresh:),
            None,
            true,
        )
    };

    app.run();
    Ok(())
}

/// A line that only shows text.
fn info_item(mtm: MainThreadMarker, title: &str) -> Retained<NSMenuItem> {
    let item = NSMenuItem::new(mtm);
    item.setTitle(&NSString::from_str(title));
    item.setEnabled(false);
    item
}

/// A line that calls a method of the controller when the user picks it.
fn action_item(
    mtm: MainThreadMarker,
    controller: &TrayController,
    title: &str,
    action: objc2::runtime::Sel,
) -> Retained<NSMenuItem> {
    let item = NSMenuItem::new(mtm);
    item.setTitle(&NSString::from_str(title));
    // SAFETY: `action` is a method of `controller` that takes the sender as
    // its one argument. A menu item does not keep its target alive: [`run`]
    // holds `controller` for as long as the event loop runs, which is the
    // rest of the program.
    unsafe {
        item.setTarget(Some(controller));
        item.setAction(Some(action));
    }
    item
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, UNIX_EPOCH};

    use super::*;
    use crate::bridge::state::SyncState;

    #[test]
    fn a_look_makes_the_menu_only_when_what_it_shows_can_be_different() {
        let now = UNIX_EPOCH + Duration::from_secs(1_794_312_000);
        let synced = SyncState {
            synced_at: Some(now - Duration::from_secs(30)),
            failed: false,
        };
        let (state, receiver) = watch::channel(BridgeState::new(synced));
        let mut watch = MenuWatch::new(receiver);
        let config_line = |look: Look| match look {
            Look::Menu(model) => model.config_line,
            other => panic!("no menu: {other:?}"),
        };

        // The first look, then nothing new.
        assert_eq!(config_line(watch.look(now)), "Config: synced just now");
        assert_eq!(watch.look(now + Duration::from_secs(29)), Look::Unchanged);
        // The age of the sync is one minute now.
        assert_eq!(
            config_line(watch.look(now + Duration::from_secs(30))),
            "Config: synced 1 minute ago"
        );
        assert_eq!(watch.look(now + Duration::from_secs(31)), Look::Unchanged);

        // A change of the state.
        state.send_modify(|state| state.status = BridgeStatus::Connected);
        let Look::Menu(model) = watch.look(now + Duration::from_secs(32)) else {
            panic!("no menu");
        };
        assert_eq!(model.status, BridgeStatus::Connected);
        assert_eq!(watch.look(now + Duration::from_secs(33)), Look::Unchanged);

        drop(state);
        assert_eq!(watch.look(now + Duration::from_secs(34)), Look::Ended);
    }
}
