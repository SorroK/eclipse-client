#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod accounts;
mod backend;
mod discord;
mod essentials;
mod installer;
mod java;
mod launch;
mod loaders;
mod model;
mod modpacks;
mod modrinth;
mod paths;
mod render;
mod rules;
mod runtime;
mod store;
mod updates;
mod util;

use backend::launcher;
use launch as launcher_engine;
use runtime::Runtime;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{Emitter, Manager, WindowEvent};

fn main() {
    let smoke_started = Arc::new(AtomicBool::new(false));
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let runtime = Runtime::new(app.handle().clone())
                .map_err(|error| std::io::Error::new(std::io::ErrorKind::Other, error))?;
            let test_runtime = runtime.clone();
            let test_handle = app.handle().clone();
            app.manage(runtime);
            if let Ok(spec) = std::env::var("ECLIPSE_CLIENT_TEST_MODPACK") {
                let test_runtime = test_runtime.clone();
                let test_handle = test_handle.clone();
                tauri::async_runtime::spawn(async move {
                    println!("MODPACK_TEST_START {spec}");
                    let Some((loader, game_version)) = spec.split_once(':') else {
                        println!("MODPACK_TEST_FAILED expected loader:gameVersion");
                        test_handle.exit(1);
                        return;
                    };
                    let _ = test_runtime.refresh_catalog(false).await;
                    let input = serde_json::json!({
                        "name": "Rust Test Pack",
                        "gameVersion": game_version,
                        "loader": loader,
                        "source": { "type": "test" }
                    });
                    match modpacks::create_modpack(&test_runtime, input).await {
                        Ok(value) => {
                            if let Some(id) = value.get("id").and_then(serde_json::Value::as_str) {
                                if let Ok(path) = test_runtime.paths.version_json(id) {
                                    if let Ok(raw) = std::fs::read_to_string(path) {
                                        if let Ok(meta) = serde_json::from_str::<serde_json::Value>(&raw) {
                                            println!(
                                                "MODPACK_TEST_META mainClass={} libraries={}",
                                                meta.get("mainClass").and_then(serde_json::Value::as_str).unwrap_or(""),
                                                meta.get("libraries").and_then(serde_json::Value::as_array).map(|rows| rows.len()).unwrap_or(0)
                                            );
                                        }
                                    }
                                }
                            }
                            if std::env::var("ECLIPSE_CLIENT_TEST_ESSENTIALS").as_deref() == Ok("1") {
                                if let Some(id) = value.get("id").and_then(serde_json::Value::as_str) {
                                    match essentials::install(&test_runtime, id).await {
                                        Ok(result) => println!("ESSENTIALS_TEST_OK {result}"),
                                        Err(error) => {
                                            println!("ESSENTIALS_TEST_FAILED {error}");
                                            test_handle.exit(1);
                                            return;
                                        }
                                    }
                                }
                            }
                            if let Ok(spec) = std::env::var("ECLIPSE_CLIENT_TEST_RENDER") {
                                let values: Vec<i32> = spec
                                    .split(',')
                                    .filter_map(|value| value.trim().parse().ok())
                                    .collect();
                                if values.len() != 4 {
                                    println!("RENDER_TEST_FAILED expected item_frames,players,dropped_items,armor_stands");
                                    test_handle.exit(1);
                                    return;
                                }
                                if let Some(id) = value.get("id").and_then(serde_json::Value::as_str) {
                                    let input = serde_json::json!({
                                        "versionId": id,
                                        "distances": {
                                            "itemFrames": values[0],
                                            "players": values[1],
                                            "droppedItems": values[2],
                                            "armorStands": values[3]
                                        }
                                    });
                                    match render::apply(&test_runtime, input).await {
                                        Ok(result) => println!("RENDER_TEST_OK {result}"),
                                        Err(error) => {
                                            println!("RENDER_TEST_FAILED {error}");
                                            test_handle.exit(1);
                                            return;
                                        }
                                    }
                                }
                            }
                            println!("MODPACK_TEST_OK {value}");
                            test_handle.exit(0);
                        }
                        Err(error) => {
                            println!("MODPACK_TEST_FAILED {error}");
                            test_handle.exit(1);
                        }
                    }
                });
            }
            if std::env::var("ECLIPSE_CLIENT_TEST_ESSENTIALS_REMOVE").as_deref() == Ok("1") {
                let test_runtime = test_runtime.clone();
                let test_handle = test_handle.clone();
                tauri::async_runtime::spawn(async move {
                    println!("ESSENTIALS_REMOVE_TEST_START");
                    let id = test_runtime.state().modpacks.first().map(|row| row.id.clone());
                    let Some(id) = id else {
                        println!("ESSENTIALS_REMOVE_TEST_FAILED no modpack");
                        test_handle.exit(1);
                        return;
                    };
                    match essentials::remove(&test_runtime, &id) {
                        Ok(value) => {
                            let count = value.get("removed").and_then(serde_json::Value::as_array).map(|rows| rows.len()).unwrap_or(0);
                            let status = value.get("status").cloned().unwrap_or(serde_json::Value::Null);
                            println!("ESSENTIALS_REMOVE_TEST_OK removed={count} status={status}");
                            test_handle.exit(0);
                        }
                        Err(error) => {
                            println!("ESSENTIALS_REMOVE_TEST_FAILED {error}");
                            test_handle.exit(1);
                        }
                    }
                });
            }
            if let Ok(version_id) = std::env::var("ECLIPSE_CLIENT_TEST_LAUNCH") {
                let test_runtime = test_runtime.clone();
                let test_handle = test_handle.clone();
                tauri::async_runtime::spawn(async move {
                    println!("LAUNCH_TEST_START {version_id}");
                    let _ = test_runtime.refresh_catalog(false).await;
                    let _ = test_runtime.refresh_java().await;
                    {
                        let mut state = test_runtime.state();
                        state.settings.fast_launch = false;
                        state.settings.minimize_on_launch = false;
                    }
                    match launcher_engine::launch_game(&test_runtime, &version_id).await {
                        Ok(value) => {
                            println!("LAUNCH_TEST_STARTED {value}");
                            tokio::time::sleep(Duration::from_secs(25)).await;
                            let running = test_runtime.state().game.as_ref().map(|game| game.status == "running").unwrap_or(false);
                            if !running {
                                println!("LAUNCH_TEST_FAILED Minecraft exited before it was ready.");
                                test_handle.exit(1);
                                return;
                            }
                            match launcher_engine::stop_game(&test_runtime).await {
                                Ok(_) => {
                                    tokio::time::sleep(Duration::from_secs(1)).await;
                                    println!("LAUNCH_TEST_OK");
                                    test_handle.exit(0);
                                }
                                Err(error) => {
                                    println!("LAUNCH_TEST_FAILED {error}");
                                    test_handle.exit(1);
                                }
                            }
                        }
                        Err(error) => {
                            println!("LAUNCH_TEST_FAILED {error}");
                            test_handle.exit(1);
                        }
                    }
                });
            }
            Ok(())
        })
        .on_page_load(move |webview, _payload| {
            if std::env::var("ECLIPSE_CLIENT_SMOKE_UI").as_deref() != Ok("1") {
                return;
            }
            if smoke_started.swap(true, Ordering::SeqCst) {
                return;
            }
            let webview = webview.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_secs(5)).await;
                let _ = webview.eval(include_str!("smoke.js"));
            });
        })
        .on_window_event(|window, event| {
            if matches!(event, WindowEvent::Resized(_)) {
                if let Ok(maximized) = window.is_maximized() {
                    let _ = window.app_handle().emit("window:maximized", maximized);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![launcher])
        .run(tauri::generate_context!())
        .expect("error while running Eclipse Client");
}
