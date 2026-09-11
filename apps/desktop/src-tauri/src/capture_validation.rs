//! Native validation for capture v2 (`app` + annotations with region pixels
//! and accessibility elements). Counts UTF-16 units like Zod does in JS.
use serde_json::{Map, Value};
use uuid::Uuid;

type Check = Result<(), String>;

fn object<'a>(v: &'a Value, keys: &[&str]) -> Result<&'a Map<String, Value>, String> {
    let o = v.as_object().ok_or("Expected an object")?;
    if o.keys().any(|k| !keys.contains(&k.as_str())) {
        return Err("Unknown field in capture".into());
    }
    Ok(o)
}
fn field<'a>(o: &'a Map<String, Value>, key: &str) -> Result<&'a Value, String> {
    o.get(key).ok_or_else(|| format!("Missing {key}"))
}
fn text(v: &Value, max: usize) -> Result<&str, String> {
    let s = v.as_str().ok_or("Expected a string")?;
    if s.encode_utf16().count() > max {
        return Err(format!("String exceeds {max} UTF-16 code units"));
    }
    Ok(s)
}
fn uuid(v: &Value) -> Check {
    let s = text(v, 36)?;
    if s.len() != 36 || Uuid::parse_str(s).is_err() {
        return Err("Expected a UUID".into());
    }
    Ok(())
}
fn number(v: &Value, min: f64, max: f64, integer: bool) -> Check {
    let n = v.as_f64().ok_or("Expected a number")?;
    if !n.is_finite() || n < min || n > max || (integer && n.fract() != 0.) {
        return Err("Number is outside its budget".into());
    }
    Ok(())
}
fn rect(v: &Value) -> Check {
    let r = object(v, &["x", "y", "width", "height"])?;
    number(field(r, "x")?, -100_000., 100_000., false)?;
    number(field(r, "y")?, -100_000., 100_000., false)?;
    number(field(r, "width")?, 0., 100_000., true)?;
    number(field(r, "height")?, 0., 100_000., true)
}

fn validate_image(v: &Value) -> Check {
    let image = object(
        v,
        &["resourceUri", "mimeType", "byteLength", "width", "height"],
    )?;
    let uri = text(field(image, "resourceUri")?, 300)?;
    if !uri.starts_with("uigrep://captures/") {
        return Err("Image resource must live under uigrep://captures/".into());
    }
    let mime = text(field(image, "mimeType")?, 20)?;
    if mime != "image/png" && mime != "image/webp" {
        return Err("Unsupported image format".into());
    }
    number(field(image, "byteLength")?, 0., 20_000_000., true)?;
    number(field(image, "width")?, 1., 10_000., true)?;
    number(field(image, "height")?, 1., 10_000., true)
}

fn validate_element(v: &Value) -> Check {
    let element = object(v, &["role", "label", "identifier", "value"])?;
    text(field(element, "role")?, 64)?;
    if let Some(label) = element.get("label") {
        text(label, 2_000)?;
    }
    if let Some(identifier) = element.get("identifier") {
        if !identifier.is_null() {
            text(identifier, 512)?;
        }
    }
    if let Some(value) = element.get("value") {
        if !value.is_null() {
            text(value, 2_000)?;
        }
    }
    Ok(())
}

fn validate_annotation(v: &Value, index: usize) -> Check {
    let a = object(
        v,
        &["id", "order", "comment", "rect", "image", "elements"],
    )?;
    uuid(field(a, "id")?)
        .map_err(|e| format!("Annotation {index}: {e}"))?;
    number(field(a, "order")?, 1., 50., true)
        .map_err(|e| format!("Annotation {index}: {e}"))?;
    text(field(a, "comment")?, 4_000)
        .map_err(|e| format!("Annotation {index}: {e}"))?;
    rect(field(a, "rect")?).map_err(|e| format!("Annotation {index}: {e}"))?;
    validate_image(field(a, "image")?)
        .map_err(|e| format!("Annotation {index}: {e}"))?;
    let elements = field(a, "elements")?
        .as_array()
        .ok_or("elements must be an array")?;
    if elements.len() > 50 {
        return Err(format!("Annotation {index}: too many elements"));
    }
    for element in elements {
        validate_element(element).map_err(|e| format!("Annotation {index}: {e}"))?;
    }
    Ok(())
}

pub fn normalize_capture(capture: &mut Value) {
    let o = match capture.as_object_mut() {
        Some(o) => o,
        None => return,
    };
    if !o.contains_key("relationships") {
        o.insert("relationships".to_string(), Value::Array(Vec::new()));
    }
    if let Some(annotations) = o.get_mut("annotations").and_then(Value::as_array_mut) {
        for annotation in annotations {
            let a = match annotation.as_object_mut() {
                Some(a) => a,
                None => continue,
            };
            a.entry("comment".to_string()).or_insert_with(|| Value::String(String::new()));
            if !a.contains_key("elements") {
                a.insert("elements".to_string(), Value::Array(Vec::new()));
            }
        }
    }
}

pub fn validate_capture(capture: &Value) -> Check {
    let c = object(
        capture,
        &[
            "schemaVersion",
            "id",
            "capturedAt",
            "status",
            "app",
            "annotations",
            "relationships",
        ],
    )?;
    if capture["schemaVersion"].as_i64() != Some(2) {
        return Err("schemaVersion must be 2".into());
    }
    uuid(field(c, "id")?)?;
    let captured_at = text(field(c, "capturedAt")?, 40)?;
    if chrono::DateTime::parse_from_rfc3339(captured_at).is_err() {
        return Err("capturedAt must be RFC 3339".into());
    }
    let status = text(field(c, "status")?, 20)?;
    if status != "pending" && status != "retrieved" {
        return Err("Unknown capture status".into());
    }
    let app = object(field(c, "app")?, &["name", "bundleId", "windowTitle", "url"])?;
    text(field(app, "name")?, 200)?;
    text(field(app, "bundleId")?, 300)?;
    if let Some(title) = app.get("windowTitle") {
        if !title.is_null() {
            text(title, 500)?;
        }
    }
    if let Some(url) = app.get("url") {
        if !url.is_null() {
            let url = text(url, 2_048)?;
            if url::Url::parse(url).is_err() {
                return Err("app.url must be a valid URL".into());
            }
        }
    }
    let annotations = field(c, "annotations")?
        .as_array()
        .ok_or("annotations must be an array")?;
    if annotations.is_empty() || annotations.len() > 50 {
        return Err(String::from("A capture must contain between 1 and 50 annotations."));
    }
    for (index, annotation) in annotations.iter().enumerate() {
        validate_annotation(annotation, index + 1)?;
    }
    let relationships = field(c, "relationships")?
        .as_array()
        .ok_or("relationships must be an array")?;
    if relationships.len() > 50 {
        return Err(String::from("Too many relationships"));
    }
    let ids: Vec<String> = annotations
        .iter()
        .filter_map(|a| a["id"].as_str().map(str::to_owned))
        .collect();
    if ids.len() != ids.iter().collect::<std::collections::HashSet<_>>().len() {
        return Err(String::from("Duplicate annotation ids"));
    }
    Ok(())
}

pub fn fixture() -> Value {
    serde_json::json!({
        "schemaVersion": 2,
        "id": Uuid::new_v4().to_string(),
        "capturedAt": chrono::Utc::now().to_rfc3339(),
        "status": "pending",
        "app": { "name": "Ledger", "bundleId": "com.salzdevs.ledger", "windowTitle": "Invoices" },
        "annotations": [{
            "id": Uuid::new_v4().to_string(),
            "order": 1,
            "comment": "scratch",
            "rect": { "x": 10, "y": 10, "width": 100, "height": 50 },
            "image": {
                "resourceUri": "uigrep://captures/scratch/a1.png",
                "mimeType": "image/png",
                "byteLength": 1000,
                "width": 100,
                "height": 50
            },
            "elements": [{ "role": "button", "label": "Save", "identifier": "save-btn" }]
        }],
        "relationships": []
    })
}
