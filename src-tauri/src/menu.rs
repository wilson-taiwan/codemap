use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter};

/// Build the application menu.
///
/// Supplying a custom menu *replaces* Tauri's default one wholesale, and the
/// first version of this file defined only File and Help. On macOS the
/// clipboard shortcuts are not a webview feature — they are dispatched by the
/// Edit menu — so with no Edit submenu, ⌘C / ⌘V / ⌘X / ⌘Z did nothing anywhere
/// in the app, including the memo boxes, which are the one place a coder
/// genuinely needs to paste. Likewise ⌘M did nothing without a Window submenu.
///
/// Separators are constructed per use site rather than shared: an NSMenuItem
/// belongs to one menu, so passing the same `&separator` into several
/// positions does not reliably render in all of them.
pub fn build_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let mut menus: Vec<Submenu<tauri::Wry>> = Vec::new();

    // On macOS the first submenu is rendered as the application menu, titled
    // with the app name regardless of what we call it.
    #[cfg(target_os = "macos")]
    {
        let about = MenuItem::with_id(app, "app_about", "About Codemap", true, None::<&str>)?;
        menus.push(Submenu::with_items(
            app,
            "Codemap",
            true,
            &[
                &about,
                &PredefinedMenuItem::separator(app)?,
                &PredefinedMenuItem::services(app, None)?,
                &PredefinedMenuItem::separator(app)?,
                &PredefinedMenuItem::hide(app, None)?,
                &PredefinedMenuItem::hide_others(app, None)?,
                &PredefinedMenuItem::show_all(app, None)?,
                &PredefinedMenuItem::separator(app)?,
                &PredefinedMenuItem::quit(app, Some("Quit Codemap"))?,
            ],
        )?);
    }

    let new_project =
        MenuItem::with_id(app, "file_new", "New Project…", true, Some("CmdOrCtrl+N"))?;
    let open = MenuItem::with_id(app, "file_open", "Open Project…", true, Some("CmdOrCtrl+O"))?;
    let project_files = MenuItem::with_id(
        app,
        "file_project_files",
        "Project Files…",
        true,
        None::<&str>,
    )?;
    let export = MenuItem::with_id(app, "file_export", "Export Files", true, None::<&str>)?;
    let close = MenuItem::with_id(app, "file_close", "Close Project", true, None::<&str>)?;

    // Declared unconditionally so they outlive the borrows in `file_items`.
    // Quit lives in the app menu on macOS, so File only carries it elsewhere.
    let sep_top = PredefinedMenuItem::separator(app)?;
    let sep_quit = PredefinedMenuItem::separator(app)?;
    let quit = PredefinedMenuItem::quit(app, Some("Quit"))?;

    #[allow(unused_mut)] // only mutated off-macOS, to append Quit
    let mut file_items: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> = vec![
        &new_project,
        &open,
        &sep_top,
        &project_files,
        &export,
        &close,
    ];
    #[cfg(not(target_os = "macos"))]
    {
        file_items.push(&sep_quit);
        file_items.push(&quit);
    }
    #[cfg(target_os = "macos")]
    let _ = (&sep_quit, &quit);

    menus.push(Submenu::with_items(app, "File", true, &file_items)?);

    // Load-bearing on macOS: without these items the clipboard shortcuts are
    // dead in every text field in the app.
    menus.push(Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?);

    menus.push(Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, Some("Zoom"))?,
            &PredefinedMenuItem::fullscreen(app, None)?,
        ],
    )?);

    let help = MenuItem::with_id(app, "help_guide", "Codemap User Guide", true, Some("?"))?;
    let about_help = MenuItem::with_id(app, "help_about", "About Codemap", true, None::<&str>)?;
    menus.push(Submenu::with_items(
        app,
        "Help",
        true,
        &[&help, &about_help],
    )?);

    let refs: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> = menus
        .iter()
        .map(|m| m as &dyn tauri::menu::IsMenuItem<tauri::Wry>)
        .collect();
    Menu::with_items(app, &refs)
}

pub fn handle_menu_event(app: &AppHandle, id: &str) {
    let _ = match id {
        "file_new" => app.emit("menu-new-project", ()),
        "file_open" => app.emit("menu-open-project", ()),
        "file_project_files" => app.emit("menu-project-files", ()),
        "file_export" => app.emit("menu-export", ()),
        "file_close" => app.emit("menu-close-project", ()),
        "help_guide" => app.emit("menu-open-guide", ()),
        "help_about" | "app_about" => app.emit("menu-about", ()),
        _ => Ok(()),
    };
}
