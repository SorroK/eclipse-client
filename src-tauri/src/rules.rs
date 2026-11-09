use serde_json::Value;

pub fn os_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "osx"
    } else {
        "linux"
    }
}

pub fn rule_allowed(rules: Option<&Value>, features: &std::collections::HashMap<String, bool>) -> bool {
    let Some(rules) = rules.and_then(Value::as_array) else { return true };
    if rules.is_empty() {
        return true;
    }
    let mut allowed = false;
    for rule in rules {
        let action = rule.get("action").and_then(Value::as_str).unwrap_or("allow");
        if rule_matches(rule, features) {
            allowed = action != "disallow";
        }
    }
    allowed
}

fn rule_matches(rule: &Value, features: &std::collections::HashMap<String, bool>) -> bool {
    if let Some(os) = rule.get("os") {
        if let Some(name) = os.get("name").and_then(Value::as_str) {
            if name != os_name() {
                return false;
            }
        }
        if let Some(arch) = os.get("arch").and_then(Value::as_str) {
            let current = if cfg!(target_arch = "x86_64") { "x86" } else { std::env::consts::ARCH };
            if arch != current {
                return false;
            }
        }
        if let Some(version) = os.get("version").and_then(Value::as_str) {
            if !version.is_empty() && !os_version_matches(version) {
                return false;
            }
        }
    }
    if let Some(required) = rule.get("features").and_then(Value::as_object) {
        for (key, value) in required {
            let expected = value.as_bool().unwrap_or(false);
            if features.get(key).copied().unwrap_or(false) != expected {
                return false;
            }
        }
    }
    true
}

fn os_version_matches(pattern: &str) -> bool {
    let Ok(regex) = regex::Regex::new(pattern) else { return true };
    let version = if cfg!(target_os = "windows") {
        "10.0".to_string()
    } else {
        "0".to_string()
    };
    regex.is_match(&version)
}
