//! Shared string limits count UTF-16 units, as Zod does in JavaScript. Native
//! ingestion also enforces dictionary byte/count and geometry/resource budgets,
//! strict keys, and relationship integrity beyond the shared schema.
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
fn enumeration(v: &Value, values: &[&str]) -> Check {
    if !values.contains(&v.as_str().unwrap_or("")) {
        return Err("Invalid enum value".into());
    }
    Ok(())
}
fn array(v: &Value, min: usize, max: usize) -> Result<&Vec<Value>, String> {
    let a = v.as_array().ok_or("Expected an array")?;
    if a.len() < min || a.len() > max {
        return Err(format!("Array must contain {min}..{max} entries"));
    }
    Ok(a)
}
fn rect(v: &Value, size: bool) -> Check {
    let o = object(
        v,
        if size {
            &["x", "y", "width", "height"]
        } else {
            &["x", "y"]
        },
    )?;
    for k in ["x", "y"] {
        number(field(o, k)?, -1e12, 1e12, false)?;
    }
    if size {
        for k in ["width", "height"] {
            number(field(o, k)?, 0., 1e12, false)?;
        }
    }
    Ok(())
}
fn dictionary(v: &Value, count: usize, value_units: usize, total_bytes: usize) -> Check {
    let o = v.as_object().ok_or("Expected a dictionary")?;
    if o.len() > count {
        return Err("Too many dictionary entries".into());
    }
    let mut bytes = 0;
    for (k, v) in o {
        if k.len() > 256 {
            return Err("Dictionary key too long".into());
        }
        bytes += k.len() + text(v, value_units)?.len();
    }
    if bytes > total_bytes {
        return Err("Dictionary byte budget exceeded".into());
    }
    Ok(())
}
fn target(v: &Value) -> Check {
    let o = object(
        v,
        &[
            "id",
            "rank",
            "tag",
            "text",
            "rect",
            "selectors",
            "attributes",
            "domSnippet",
            "styleFacts",
            "score",
        ],
    )?;
    uuid(field(o, "id")?)?;
    number(field(o, "rank")?, 1., 9_007_199_254_740_991., true)?;
    text(field(o, "tag")?, 64)?;
    text(field(o, "text")?, 2000)?;
    text(field(o, "domSnippet")?, 12288)?;
    rect(field(o, "rect")?, true)?;
    number(field(o, "score")?, 0., 1., false)?;
    let selectors = object(
        field(o, "selectors")?,
        &["testId", "id", "css", "xpath", "role", "accessibleName"],
    )?;
    for (k, max) in [
        ("testId", 256),
        ("id", 256),
        ("css", 2048),
        ("xpath", 2048),
        ("role", 128),
        ("accessibleName", 512),
    ] {
        if let Some(v) = selectors.get(k) {
            text(v, max)?;
        }
    }
    if let Some(v) = o.get("attributes") {
        dictionary(v, 20, 2000, 40960)?;
    }
    if let Some(v) = o.get("styleFacts") {
        dictionary(v, 100, 1024, 32768)?;
    }
    Ok(())
}
fn annotation(v: &Value) -> Check {
    let o = object(
        v,
        &[
            "id",
            "order",
            "comment",
            "selectionMethod",
            "viewportRect",
            "pageRect",
            "scroll",
            "screenshot",
            "targets",
            "hasMoreTargets",
            "status",
        ],
    )?;
    uuid(field(o, "id")?)?;
    // Array size is capped at 50; order need not be contiguous or <= 50.
    number(field(o, "order")?, 1., 9_007_199_254_740_991., true)?;
    if let Some(v) = o.get("comment") {
        text(v, 4000)?;
    }
    enumeration(field(o, "selectionMethod")?, &["click", "drag"])?;
    rect(field(o, "viewportRect")?, true)?;
    rect(field(o, "pageRect")?, true)?;
    rect(field(o, "scroll")?, false)?;
    if let Some(v) = o.get("hasMoreTargets") {
        if !v.is_boolean() {
            return Err("hasMoreTargets must be boolean".into());
        }
    }
    if let Some(v) = o.get("status") {
        enumeration(v, &["pending", "in_progress", "resolved", "blocked"])?;
    }
    for v in array(field(o, "targets")?, 0, 20)? {
        target(v)?;
    }
    if let Some(v) = o.get("screenshot") {
        let s = object(
            v,
            &["resourceUri", "mimeType", "byteLength", "width", "height"],
        )?;
        if !text(field(s, "resourceUri")?, 2048)?.starts_with("uigrep://") {
            return Err("Invalid screenshot resource URI".into());
        }
        enumeration(
            field(s, "mimeType")?,
            &["image/png", "image/webp", "image/jpeg"],
        )?;
        number(field(s, "byteLength")?, 0., 8388608., true)?;
        for k in ["width", "height"] {
            number(field(s, k)?, 1., 100000., true)?;
        }
    }
    Ok(())
}

/// Apply exactly the shared schema's defaults; null is deliberately not missing.
pub(crate) fn normalize_capture(v: &mut Value) {
    if let Some(o) = v.as_object_mut() {
        o.entry("relationships")
            .or_insert_with(|| serde_json::json!([]));
        if let Some(annotations) = o.get_mut("annotations").and_then(Value::as_array_mut) {
            for a in annotations {
                if let Some(a) = a.as_object_mut() {
                    a.entry("comment").or_insert_with(|| "".into());
                    a.entry("status").or_insert_with(|| "pending".into());
                    a.entry("hasMoreTargets").or_insert_with(|| false.into());
                    if let Some(targets) = a.get_mut("targets").and_then(Value::as_array_mut) {
                        for target in targets {
                            if let Some(t) = target.as_object_mut() {
                                t.entry("attributes")
                                    .or_insert_with(|| serde_json::json!({}));
                                t.entry("styleFacts")
                                    .or_insert_with(|| serde_json::json!({}));
                            }
                        }
                    }
                }
            }
        }
        if let Some(relationships) = o.get_mut("relationships").and_then(Value::as_array_mut) {
            for r in relationships {
                if let Some(r) = r.as_object_mut() {
                    r.entry("properties")
                        .or_insert_with(|| serde_json::json!([]));
                }
            }
        }
    }
}

pub(crate) fn validate_capture(v: &Value) -> Check {
    let o = object(
        v,
        &[
            "schemaVersion",
            "id",
            "capturedAt",
            "status",
            "page",
            "annotations",
            "relationships",
        ],
    )?;
    enumeration(field(o, "schemaVersion")?, &["1.0.0"])?;
    uuid(field(o, "id")?)?;
    let date = text(field(o, "capturedAt")?, 64)?;
    if !date.ends_with('Z') || chrono::DateTime::parse_from_rfc3339(date).is_err() {
        return Err("capturedAt must be a UTC RFC3339 timestamp".into());
    }
    enumeration(
        field(o, "status")?,
        &["draft", "pending", "in_progress", "resolved", "blocked"],
    )?;
    let p = object(
        field(o, "page")?,
        &["url", "title", "viewport", "scroll", "colorScheme"],
    )?;
    let url = url::Url::parse(text(field(p, "url")?, 8192)?).map_err(|_| "Invalid page URL")?;
    if !["http", "https", "file"].contains(&url.scheme()) {
        return Err("Unsupported capture page scheme".into());
    }
    text(field(p, "title")?, 1000)?;
    rect(field(p, "scroll")?, false)?;
    enumeration(
        field(p, "colorScheme")?,
        &["light", "dark", "no-preference"],
    )?;
    let viewport = object(
        field(p, "viewport")?,
        &["width", "height", "devicePixelRatio"],
    )?;
    for k in ["width", "height"] {
        number(field(viewport, k)?, 1., 100000., true)?;
    }
    number(
        field(viewport, "devicePixelRatio")?,
        0.,
        10.,
        false,
    )?;
    if field(viewport, "devicePixelRatio")?.as_f64() == Some(0.) {
        return Err("devicePixelRatio must be positive".into());
    }
    let annotations = array(field(o, "annotations")?, 1, 50)?;
    let mut ids = std::collections::HashSet::new();
    let mut orders = std::collections::HashSet::new();
    for a in annotations {
        annotation(a)?;
        if !ids.insert(a["id"].as_str().unwrap())
            || !orders.insert(a["order"].as_f64().unwrap().to_bits())
        {
            return Err("Duplicate annotation id/order".into());
        }
    }
    if let Some(relationships) = o.get("relationships") {
        for r in array(relationships, 0, 100)? {
            let r = object(
                r,
                &[
                    "type",
                    "sourceAnnotationId",
                    "targetAnnotationId",
                    "properties",
                ],
            )?;
            enumeration(
                field(r, "type")?,
                &["reference", "match", "align", "preserve", "avoid-changing"],
            )?;
            for k in ["sourceAnnotationId", "targetAnnotationId"] {
                uuid(field(r, k)?)?;
                if !ids.contains(field(r, k)?.as_str().unwrap()) {
                    return Err("Relationship references an unknown annotation".into());
                }
            }
            if let Some(p) = r.get("properties") {
                for v in array(p, 0, 20)? {
                    text(v, 128)?;
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
pub(crate) fn fixture() -> Value {
    serde_json::json!({"schemaVersion":"1.0.0", "id":Uuid::new_v4().to_string(), "capturedAt":"2026-09-10T10:00:00.000Z", "status":"pending", "page":{"url":"https://example.com", "title":"Test", "viewport":{"width":800,"height":600,"devicePixelRatio":1}, "scroll":{"x":0,"y":0},"colorScheme":"light"}, "annotations":[{"id":Uuid::new_v4().to_string(),"order":1,"selectionMethod":"drag","viewportRect":{"x":0,"y":0,"width":20,"height":20},"pageRect":{"x":0,"y":0,"width":20,"height":20},"scroll":{"x":0,"y":0},"targets":[]}], "relationships":[]})
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn defaults_match_schema_and_null_is_not_defaulted() {
        let mut v = fixture();
        v.as_object_mut().unwrap().remove("relationships");
        normalize_capture(&mut v);
        assert_eq!(v["relationships"], serde_json::json!([]));
        assert_eq!(v["annotations"][0]["comment"], "");
        assert_eq!(v["annotations"][0]["status"], "pending");
        assert_eq!(v["annotations"][0]["hasMoreTargets"], false);
        assert!(validate_capture(&v).is_ok());
        v["annotations"][0]["comment"] = Value::Null;
        normalize_capture(&mut v);
        assert!(validate_capture(&v).is_err());
    }
    #[test]
    fn valid_and_nested_invalid() {
        let mut v = fixture();
        assert!(validate_capture(&v).is_ok());
        v["annotations"][0]["viewportRect"]["width"] = (-1).into();
        assert!(validate_capture(&v).is_err());
        let mut v = fixture();
        v["page"]["viewport"]["devicePixelRatio"] = 11.into();
        assert!(validate_capture(&v).is_err());
        let mut v = fixture();
        v["annotations"][0]["comment"] = "é".repeat(4001).into();
        assert!(validate_capture(&v).is_err());
        assert!(validate_capture(&serde_json::json!({"id":Uuid::new_v4()})).is_err());
    }
    #[test]
    fn bounded_dictionaries_and_relationships() {
        let mut values = Map::new();
        for n in 0..21 {
            values.insert(n.to_string(), "x".into());
        }
        assert!(dictionary(&Value::Object(values), 20, 2000, 40960).is_err());
        let mut v = fixture();
        v["relationships"] = serde_json::json!([{"type":"match","sourceAnnotationId":Uuid::new_v4().to_string(),"targetAnnotationId":Uuid::new_v4().to_string()}]);
        assert!(validate_capture(&v).is_err());
    }

    #[test]
    fn unicode_limits_count_utf16_not_utf8_bytes() {
        let mut v = fixture();
        for comment in ["é".repeat(4000), "界".repeat(4000), "😀".repeat(2000)] {
            v["annotations"][0]["comment"] = comment.into();
            assert!(validate_capture(&v).is_ok());
        }
        v["annotations"][0]["comment"] = "😀".repeat(2001).into();
        assert!(validate_capture(&v).is_err());
        assert!(dictionary(&serde_json::json!({"title":"界".repeat(2000)}), 20, 2000, 40960).is_ok());
        assert!(dictionary(&serde_json::json!({"title":"界".repeat(2000)}), 20, 2000, 4096).is_err());
    }

    #[test]
    fn annotation_orders_are_not_array_indices_and_numeric_duplicates_are_rejected() {
        let mut v = fixture();
        v["annotations"][0]["order"] = 99.into();
        assert!(validate_capture(&v).is_ok());
        let mut second = v["annotations"][0].clone();
        second["id"] = Uuid::new_v4().to_string().into();
        second["order"] = serde_json::json!(100.0);
        v["annotations"].as_array_mut().unwrap().push(second);
        assert!(validate_capture(&v).is_ok());
        v["annotations"][0]["order"] = 100.into();
        assert!(validate_capture(&v).is_err());
    }
}
