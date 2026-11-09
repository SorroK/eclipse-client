//! Discord Rich Presence over Discord's local IPC pipe.
//!
//! On Windows Discord listens on `\\.\pipe\discord-ipc-0` through `-9`. Every
//! message is an 8-byte little-endian header (opcode, payload length) followed
//! by a JSON body. We only need the handshake (opcode 0) and `SET_ACTIVITY`
//! (opcode 1); responses are drained and inspected so a closed pipe or an
//! invalid application ID is noticed instead of silently breaking presence.

use serde_json::{json, Value};
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

type Logger = Arc<dyn Fn(&str) + Send + Sync>;

const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(3);
const RETRY_INTERVAL: Duration = Duration::from_secs(15);
const POLL_INTERVAL: Duration = Duration::from_secs(2);

/// Text shown on the Discord profile. Discord limits each line to 128 bytes.
#[derive(Clone, Debug, PartialEq)]
pub struct Presence {
    pub details: String,
    pub state: String,
    pub start_timestamp: Option<i64>,
}

impl Presence {
    fn activity(&self) -> Value {
        let mut activity = serde_json::Map::new();
        activity.insert("details".into(), json!(clip(&self.details, 128)));
        activity.insert("state".into(), json!(clip(&self.state, 128)));
        if let Some(start) = self.start_timestamp {
            activity.insert("timestamps".into(), json!({ "start": start }));
        }
        Value::Object(activity)
    }
}

fn clip(value: &str, limit: usize) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return "Eclipse Client".into();
    }
    if trimmed.chars().count() <= limit {
        return trimmed.to_string();
    }
    let short: String = trimmed.chars().take(limit.saturating_sub(1)).collect();
    format!("{}…", short.trim_end())
}

struct Worker {
    client_id: String,
    stop: Arc<AtomicBool>,
    wake: Sender<()>,
}

pub struct DiscordRpc {
    worker: Mutex<Option<Worker>>,
    latest: Arc<Mutex<Option<Presence>>>,
    logger: Mutex<Option<Logger>>,
    missing_id_logged: AtomicBool,
}

impl DiscordRpc {
    pub fn new() -> Self {
        Self {
            worker: Mutex::new(None),
            latest: Arc::new(Mutex::new(None)),
            logger: Mutex::new(None),
            missing_id_logged: AtomicBool::new(false),
        }
    }

    pub fn set_logger(&self, logger: Logger) {
        *self.logger.lock().unwrap_or_else(|poison| poison.into_inner()) = Some(logger);
    }

    /// Reconcile the worker with the current settings and presence.
    pub fn update(&self, enabled: bool, configured_client_id: &str, presence: Option<Presence>) {
        if !enabled {
            self.stop();
            self.missing_id_logged.store(false, Ordering::Relaxed);
            return;
        }
        let client_id = std::env::var("ECLIPSE_DISCORD_CLIENT_ID")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| is_client_id(value))
            .or_else(|| {
                let value = configured_client_id.trim().to_string();
                if is_client_id(&value) { Some(value) } else { None }
            });
        let Some(client_id) = client_id else {
            self.stop();
            if !self.missing_id_logged.swap(true, Ordering::Relaxed) {
                self.log("Discord Rich Presence is on, but no Discord Application ID is set. Add one in Settings → Discord Rich Presence.");
            }
            return;
        };
        self.missing_id_logged.store(false, Ordering::Relaxed);

        {
            let worker = self.worker.lock().unwrap_or_else(|poison| poison.into_inner());
            if let Some(existing) = worker.as_ref() {
                if existing.client_id == client_id {
                    *self.latest.lock().unwrap_or_else(|poison| poison.into_inner()) = presence;
                    let _ = existing.wake.send(());
                    return;
                }
            }
        }

        self.stop();
        *self.latest.lock().unwrap_or_else(|poison| poison.into_inner()) = presence;
        self.start(client_id);
    }

    fn start(&self, client_id: String) {
        let (wake, receiver) = mpsc::channel();
        let stop = Arc::new(AtomicBool::new(false));
        let latest = self.latest.clone();
        let logger = self.logger.lock().unwrap_or_else(|poison| poison.into_inner()).clone();
        let thread_stop = stop.clone();
        let thread_id = client_id.clone();
        let _ = thread::Builder::new()
            .name("eclipse-discord-rpc".into())
            .spawn(move || worker_loop(thread_id, latest, receiver, thread_stop, logger));
        *self.worker.lock().unwrap_or_else(|poison| poison.into_inner()) =
            Some(Worker { client_id, stop, wake });
    }

    fn stop(&self) {
        let existing = self
            .worker
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .take();
        if let Some(worker) = existing {
            worker.stop.store(true, Ordering::Relaxed);
            let _ = worker.wake.send(());
        }
    }

    fn log(&self, message: &str) {
        if let Some(logger) = self.logger.lock().unwrap_or_else(|poison| poison.into_inner()).clone() {
            logger(message);
        }
    }
}

fn is_client_id(value: &str) -> bool {
    (10..=32).contains(&value.len()) && value.bytes().all(|byte| byte.is_ascii_digit())
}

fn worker_loop(
    client_id: String,
    latest: Arc<Mutex<Option<Presence>>>,
    wake: Receiver<()>,
    stop: Arc<AtomicBool>,
    logger: Option<Logger>,
) {
    let log = |message: &str| {
        if let Some(logger) = &logger {
            logger(message);
        }
    };
    let mut announced_wait = false;
    let mut last_error: Option<String> = None;

    while !stop.load(Ordering::Relaxed) {
        match connect(&client_id) {
            Ok(mut connection) => {
                if let Err(error) = connection.wait_for_ready() {
                    if last_error.as_deref() != Some(error.as_str()) {
                        log(&format!("Discord did not accept the Rich Presence connection: {error}"));
                        last_error = Some(error);
                    }
                } else {
                    announced_wait = false;
                    last_error = None;
                    log("Discord Rich Presence connected.");
                    let mut sent = latest.lock().unwrap_or_else(|poison| poison.into_inner()).clone();
                    let _ = send_activity(&mut connection, sent.as_ref());
                    loop {
                        match wake.recv_timeout(POLL_INTERVAL) {
                            Ok(()) | Err(RecvTimeoutError::Timeout) => {}
                            Err(RecvTimeoutError::Disconnected) => return,
                        }
                        if stop.load(Ordering::Relaxed) {
                            return;
                        }
                        match connection.read_events() {
                            Ok(events) => {
                                for event in events {
                                    if let Some(error) = event_error(&event) {
                                        log(&format!("Discord rejected the presence: {error}"));
                                    }
                                }
                            }
                            Err(error) => {
                                if last_error.as_deref() != Some(error.as_str()) {
                                    log(&format!("Discord connection closed ({error})."));
                                    last_error = Some(error);
                                }
                                break;
                            }
                        }
                        let activity = latest.lock().unwrap_or_else(|poison| poison.into_inner()).clone();
                        if activity == sent {
                            continue;
                        }
                        if let Err(error) = send_activity(&mut connection, activity.as_ref()) {
                            if last_error.as_deref() != Some(error.as_str()) {
                                log(&format!("Discord connection closed ({error})."));
                                last_error = Some(error);
                            }
                            break;
                        }
                        sent = activity;
                    }
                }
            }
            Err(error) => {
                if !announced_wait {
                    log(&format!("Discord is not reachable yet ({error}). Eclipse will keep trying in the background."));
                    announced_wait = true;
                }
            }
        }

        match wake.recv_timeout(RETRY_INTERVAL) {
            Ok(()) => {}
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return,
        }
    }
}

struct Connection {
    pipe: std::fs::File,
    buffer: Vec<u8>,
}

impl Connection {
    fn write_frame(&mut self, opcode: u32, payload: &Value) -> Result<(), String> {
        let body = serde_json::to_vec(payload).map_err(|error| error.to_string())?;
        let mut frame = Vec::with_capacity(8 + body.len());
        frame.extend_from_slice(&opcode.to_le_bytes());
        frame.extend_from_slice(&(body.len() as u32).to_le_bytes());
        frame.extend_from_slice(&body);
        self.pipe.write_all(&frame).map_err(|error| error.to_string())?;
        self.pipe.flush().map_err(|error| error.to_string())
    }

    fn read_events(&mut self) -> Result<Vec<Value>, String> {
        loop {
            let available = available_bytes(&self.pipe)?;
            if available == 0 {
                return Ok(take_frames(&mut self.buffer));
            }
            let mut chunk = vec![0u8; (available as usize).min(64 * 1024)];
            self.pipe.read_exact(&mut chunk).map_err(|error| error.to_string())?;
            self.buffer.extend_from_slice(&chunk);
        }
    }

    fn wait_for_ready(&mut self) -> Result<(), String> {
        let deadline = Instant::now() + HANDSHAKE_TIMEOUT;
        loop {
            for event in self.read_events()? {
                if let Some(error) = event_error(&event) {
                    return Err(error);
                }
                if event.get("evt").and_then(Value::as_str) == Some("READY") {
                    return Ok(());
                }
            }
            if Instant::now() >= deadline {
                return Err("Discord did not acknowledge the connection.".into());
            }
            thread::sleep(Duration::from_millis(25));
        }
    }
}

fn connect(client_id: &str) -> Result<Connection, String> {
    #[cfg(windows)]
    {
        if let Ok(path) = std::env::var("ECLIPSE_DISCORD_PIPE") {
            let pipe = std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .open(&path)
                .map_err(|error| error.to_string())?;
            let mut connection = Connection { pipe, buffer: Vec::new() };
            connection.write_frame(0, &json!({ "v": 1, "client_id": client_id }))?;
            return Ok(connection);
        }
        let mut last_error = String::from("Discord is not running.");
        for index in 0..10 {
            let path = format!(r"\\.\pipe\discord-ipc-{index}");
            match std::fs::OpenOptions::new().read(true).write(true).open(&path) {
                Ok(pipe) => {
                    let mut connection = Connection { pipe, buffer: Vec::new() };
                    connection.write_frame(0, &json!({ "v": 1, "client_id": client_id }))?;
                    return Ok(connection);
                }
                Err(error) => last_error = error.to_string(),
            }
        }
        Err(last_error)
    }
    #[cfg(not(windows))]
    {
        let _ = client_id;
        Err("Discord Rich Presence is only supported on Windows.".into())
    }
}

fn send_activity(connection: &mut Connection, presence: Option<&Presence>) -> Result<(), String> {
    let activity = presence.map(Presence::activity).unwrap_or(Value::Null);
    connection.write_frame(
        1,
        &json!({
            "cmd": "SET_ACTIVITY",
            "args": { "pid": std::process::id(), "activity": activity },
            "nonce": uuid::Uuid::new_v4().to_string()
        }),
    )
}

fn event_error(event: &Value) -> Option<String> {
    if event.get("evt").and_then(Value::as_str) != Some("ERROR") {
        return None;
    }
    event
        .pointer("/data/message")
        .and_then(Value::as_str)
        .or_else(|| event.get("message").and_then(Value::as_str))
        .map(str::to_string)
        .or_else(|| Some("Unknown Discord error.".into()))
}

fn take_frames(buffer: &mut Vec<u8>) -> Vec<Value> {
    let mut events = Vec::new();
    loop {
        if buffer.len() < 8 {
            break;
        }
        let opcode = u32::from_le_bytes([buffer[0], buffer[1], buffer[2], buffer[3]]);
        let length = u32::from_le_bytes([buffer[4], buffer[5], buffer[6], buffer[7]]) as usize;
        if length > 1_048_576 {
            buffer.clear();
            break;
        }
        if buffer.len() < 8 + length {
            break;
        }
        let body = buffer[8..8 + length].to_vec();
        buffer.drain(..8 + length);
        if opcode == 1 {
            if let Ok(value) = serde_json::from_slice::<Value>(&body) {
                events.push(value);
            }
        }
    }
    events
}

#[cfg(windows)]
fn available_bytes(pipe: &std::fs::File) -> Result<u32, String> {
    win::available_bytes(pipe)
}

#[cfg(not(windows))]
fn available_bytes(_pipe: &std::fs::File) -> Result<u32, String> {
    Err("Discord Rich Presence is only supported on Windows.".into())
}

#[cfg(windows)]
mod win {
    use std::ffi::c_void;
    use std::fs::File;
    use std::os::windows::io::AsRawHandle;

    #[link(name = "kernel32")]
    extern "system" {
        fn PeekNamedPipe(
            h_named_pipe: *mut c_void,
            lp_buffer: *mut c_void,
            n_buffer_size: u32,
            lp_bytes_read: *mut u32,
            lp_total_bytes_avail: *mut u32,
            lp_bytes_left_this_message: *mut u32,
        ) -> i32;
    }

    pub fn available_bytes(file: &File) -> Result<u32, String> {
        let mut available = 0u32;
        let ok = unsafe {
            PeekNamedPipe(
                file.as_raw_handle(),
                std::ptr::null_mut(),
                0,
                std::ptr::null_mut(),
                &mut available,
                std::ptr::null_mut(),
            )
        };
        if ok == 0 {
            Err(std::io::Error::last_os_error().to_string())
        } else {
            Ok(available)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_round_trip_ignores_partial_frames() {
        let body = serde_json::to_vec(&json!({ "evt": "READY" })).unwrap();
        let mut buffer = Vec::new();
        buffer.extend_from_slice(&1u32.to_le_bytes());
        buffer.extend_from_slice(&(body.len() as u32).to_le_bytes());
        buffer.extend_from_slice(&body);
        let partial = buffer.split_off(buffer.len() - 3);
        assert!(take_frames(&mut buffer).is_empty());
        buffer.extend_from_slice(&partial);
        let events = take_frames(&mut buffer);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].get("evt").and_then(Value::as_str), Some("READY"));
    }

    #[test]
    fn activity_clips_long_lines() {
        let presence = Presence {
            details: "x".repeat(300),
            state: "Ready".into(),
            start_timestamp: Some(10),
        };
        let activity = presence.activity();
        assert!(activity.get("details").and_then(Value::as_str).unwrap().chars().count() <= 128);
        assert_eq!(activity.pointer("/timestamps/start").and_then(Value::as_i64), Some(10));
    }
}
