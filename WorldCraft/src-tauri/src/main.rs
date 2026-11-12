// WorldCraft desktop app: a native Windows window (WebView2) showing the WorldCraft UI, with the project/file API served
// in-process on the private `craft://` scheme by the shared Rust backend. No browser, no network port.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use craft_backend::{Config, Library};
use std::path::PathBuf;

// The environment assets, built into the exe (see build.rs).
include!(concat!(env!("OUT_DIR"), "/embedded_assets.rs"));

/// Where the assets are: a folder beside the exe if there is one, else unpacked once from the exe into the data folder.
/// So running it from inside a zip, or moved on its own, can't leave a world with no textures, leaves or grass.
fn library_dir(exe_dir: &std::path::Path, data: &std::path::Path) -> PathBuf {
    let beside = exe_dir.join("asset-library").join("world");
    if beside.join("leaves").is_dir() { return beside; }
    let dir = data.join("WorldCraft").join("asset-library").join("world");
    let stamp = dir.join(".unpacked");
    if std::fs::read_to_string(&stamp).ok().as_deref() == Some(STAMP) { return dir; }
    // An older unpacked copy (ours: it has the stamp) is cleared first, so assets taken out of the library go too.
    if stamp.is_file() { let _ = std::fs::remove_dir_all(&dir); }
    for (rel, bytes) in FILES {
        let p = dir.join(rel);
        if let Some(parent) = p.parent() { let _ = std::fs::create_dir_all(parent); }
        let _ = std::fs::write(&p, bytes);
    }
    let _ = std::fs::write(&stamp, STAMP);
    dir
}

fn main() {
    let exe_dir = std::env::current_exe().ok().and_then(|p| p.parent().map(PathBuf::from)).unwrap_or_default();
    // Worlds live in %LOCALAPPDATA%\CraftApps\WorldCraft; exports go to the exchange folder GameCraft imports from.
    let data = dirs::data_local_dir().unwrap_or_else(|| exe_dir.clone()).join("CraftApps");
    let world_assets = library_dir(&exe_dir, &data);
    let cfg = Config {
        projects_dir: data.join("WorldCraft").join("projects"),
        exchange_dir: data.join("exchange"),
        libraries: vec![Library { id: "world".into(), dir: world_assets, label: "World assets".into() }],
        extensions_dir: None,
    };
    cfg.ensure_dirs();

    tauri::Builder::default()
        .register_asynchronous_uri_scheme_protocol("craft", move |_ctx, request, responder| {
            let cfg = cfg.clone();
            std::thread::spawn(move || responder.respond(craft_backend::handle(&cfg, &request)));
        })
        .run(tauri::generate_context!())
        .expect("WorldCraft failed to start");
}
