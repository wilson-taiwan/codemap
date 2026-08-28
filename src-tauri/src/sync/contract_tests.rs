use std::collections::HashMap;
use std::path::PathBuf;

use crate::sync::{classify_rpc_failure, RpcArg, RpcSpec, SyncError, RPC_CONTRACTS};

#[derive(Debug, Clone, PartialEq, Eq)]
struct ParsedFunction {
    name: String,
    args: Vec<(String, String)>,
}

fn strip_sql_comments_and_strings(sql: &str) -> String {
    let mut out = String::with_capacity(sql.len());
    let chars: Vec<char> = sql.chars().collect();
    let len = chars.len();
    let mut i = 0;

    while i < len {
        // Single-line comment: -- ...
        if i + 1 < len && chars[i] == '-' && chars[i + 1] == '-' {
            while i < len && chars[i] != '\n' {
                i += 1;
            }
            out.push(' ');
            continue;
        }

        // Multi-line comment: /* ... */
        if i + 1 < len && chars[i] == '/' && chars[i + 1] == '*' {
            i += 2;
            while i + 1 < len && !(chars[i] == '*' && chars[i + 1] == '/') {
                i += 1;
            }
            i += 2;
            out.push(' ');
            continue;
        }

        // Dollar-quoted string: $tag$...$tag$ or $$...$$
        if chars[i] == '$' {
            let mut j = i + 1;
            while j < len && (chars[j].is_alphanumeric() || chars[j] == '_') {
                j += 1;
            }
            if j < len && chars[j] == '$' {
                let tag: String = chars[i..=j].iter().collect();
                i = j + 1;
                // Scan until closing tag
                let tag_len = tag.len();
                while i + tag_len <= len {
                    let candidate: String = chars[i..i + tag_len].iter().collect();
                    if candidate == tag {
                        i += tag_len;
                        break;
                    }
                    i += 1;
                }
                out.push_str(" 'dollar_quoted' ");
                continue;
            }
        }

        // Single-quoted literal: '...'
        if chars[i] == '\'' {
            out.push('\'');
            i += 1;
            while i < len {
                if chars[i] == '\'' {
                    if i + 1 < len && chars[i + 1] == '\'' {
                        i += 2;
                    } else {
                        i += 1;
                        break;
                    }
                } else {
                    i += 1;
                }
            }
            out.push('\'');
            continue;
        }

        out.push(chars[i]);
        i += 1;
    }

    out
}

fn normalize_type(t: &str) -> String {
    let t = t.trim().to_lowercase();
    let t = t.replace("character varying", "varchar");
    let t = t.replace("timestamp with time zone", "timestamptz");
    t.replace("timestamp without time zone", "timestamp")
}

fn parse_sql_function_definitions(sql_files: Vec<PathBuf>) -> HashMap<String, ParsedFunction> {
    let mut functions: HashMap<String, ParsedFunction> = HashMap::new();

    let create_regex = regex::Regex::new(
        r"(?is)create(?:\s+or\s+replace)?\s+function\s+(?:public\.)?([a-zA-Z0-9_]+)\s*\((.*?)\)",
    )
    .unwrap();

    let drop_regex = regex::Regex::new(
        r"(?is)drop\s+function(?:\s+if\s+exists)?\s+(?:public\.)?([a-zA-Z0-9_]+)\s*\((.*?)\)",
    )
    .unwrap();

    for path in sql_files {
        let content = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("Could not read SQL file {:?}: {}", path, e));
        let cleaned = strip_sql_comments_and_strings(&content);

        // Process DROP FUNCTION statements
        for cap in drop_regex.captures_iter(&cleaned) {
            let fn_name = cap[1].to_lowercase();
            // Drop removes all overloads or specific overload
            functions.remove(&fn_name);
        }

        // Process CREATE FUNCTION statements
        for cap in create_regex.captures_iter(&cleaned) {
            let fn_name = cap[1].to_lowercase();
            let raw_args = &cap[2];

            let mut parsed_args = Vec::new();
            if !raw_args.trim().is_empty() {
                for arg_chunk in raw_args.split(',') {
                    let trimmed = arg_chunk.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    // Handle default values: e.g. "param type default val"
                    let without_default =
                        if let Some(idx) = trimmed.to_lowercase().find(" default ") {
                            &trimmed[..idx]
                        } else {
                            trimmed
                        };

                    let tokens: Vec<&str> = without_default.split_whitespace().collect();
                    if tokens.len() == 1 {
                        // Unnamed type
                        parsed_args.push((String::new(), normalize_type(tokens[0])));
                    } else if tokens.len() >= 2 {
                        let name = tokens[0].to_string();
                        let typ = normalize_type(&tokens[1..].join(" "));
                        parsed_args.push((name, typ));
                    }
                }
            }

            functions.insert(
                fn_name.clone(),
                ParsedFunction {
                    name: fn_name,
                    args: parsed_args,
                },
            );
        }
    }

    functions
}

#[test]
fn all_rpc_contracts_match_supabase_sql() {
    let supabase_dir = PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../supabase"));
    let mut files = vec![supabase_dir.join("schema.sql")];

    let mut mig_files: Vec<PathBuf> = std::fs::read_dir(&supabase_dir)
        .unwrap()
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|name| name.starts_with("migrate-") && name.ends_with(".sql"))
        })
        .collect();
    mig_files.sort();
    files.extend(mig_files);

    let parsed_funcs = parse_sql_function_definitions(files);

    for spec in RPC_CONTRACTS {
        let fn_name = spec.name.to_lowercase();
        let parsed = parsed_funcs.get(&fn_name).unwrap_or_else(|| {
            panic!(
                "RPC '{}' defined in RPC_CONTRACTS is missing from Supabase SQL definitions!",
                spec.name
            );
        });

        assert_eq!(
            parsed.args.len(),
            spec.args.len(),
            "RPC '{}' argument count mismatch: SQL has {:?}, Rust spec has {:?}",
            spec.name,
            parsed.args,
            spec.args
        );

        for (i, expected_arg) in spec.args.iter().enumerate() {
            let (sql_name, sql_type) = &parsed.args[i];
            assert_eq!(
                sql_name, expected_arg.name,
                "RPC '{}' arg #{} name mismatch: SQL has '{}', Rust spec expected '{}'",
                spec.name, i, sql_name, expected_arg.name
            );
            assert_eq!(
                sql_type, expected_arg.sql_type,
                "RPC '{}' arg #{} type mismatch: SQL has '{}', Rust spec expected '{}'",
                spec.name, i, sql_type, expected_arg.sql_type
            );
        }
    }
}

#[test]
fn rpc_url_literal_occurs_only_once_in_sync_rs() {
    let sync_rs_path = PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/src/sync.rs"));
    let content = std::fs::read_to_string(sync_rs_path).unwrap();
    let needle = "/rest/v1/rpc/";
    let occurrences = content.matches(needle).count();
    assert_eq!(
        occurrences, 1,
        "The string '{}' must occur exactly once in src/sync.rs (inside rpc_request), found {}",
        needle, occurrences
    );
}

#[test]
fn error_taxonomy_classification_and_display() {
    // 1. 401 Unauthorized
    let err = classify_rpc_failure(401, "{}", "leave_group");
    assert_eq!(err, SyncError::Unauthorized);
    assert_eq!(err.to_string(), "Your sync session expired. Sign in again.");

    // 2. 403 PermissionDenied
    let err = classify_rpc_failure(403, "{}", "delete_group");
    assert_eq!(err, SyncError::PermissionDenied);
    assert_eq!(
        err.to_string(),
        "You do not have permission to do that in this study."
    );

    // 3. 404 PGRST202 ServerFunctionUnavailable
    let body_pgrst202 = r#"{"code":"PGRST202","message":"Could not find the function public.leave_group in the schema cache"}"#;
    let err = classify_rpc_failure(404, body_pgrst202, "leave_group");
    assert_eq!(
        err,
        SyncError::ServerFunctionUnavailable {
            name: "leave_group"
        }
    );
    assert_eq!(
        err.to_string(),
        "This study's server isn't exposing a required function (leave_group). The server migration or schema cache needs attention."
    );

    // 4. 400 P0001 ServerRejected with public message
    let body_p0001 = r#"{"code":"P0001","message":"You are not a member of this study."}"#;
    let err = classify_rpc_failure(400, body_p0001, "leave_group");
    assert_eq!(
        err,
        SyncError::ServerRejected {
            status: 400,
            code: Some("P0001".into()),
            public_message: Some("You are not a member of this study.".into()),
        }
    );
    assert_eq!(err.to_string(), "You are not a member of this study.");

    // 5. 400 Unknown SQL error detail - should NOT leak SQL/raw body in Display
    let body_sql_leak = r#"{"code":"42703","message":"column c.unknown does not exist","details":"SELECT * FROM secret_table"}"#;
    let err = classify_rpc_failure(400, body_sql_leak, "some_rpc");
    assert_eq!(
        err,
        SyncError::ServerRejected {
            status: 400,
            code: Some("42703".into()),
            public_message: None,
        }
    );
    assert_eq!(
        err.to_string(),
        "The study server could not complete that request (HTTP 400)."
    );
    assert!(!err.to_string().contains("secret_table"));

    // 6. 503 Empty body
    let err = classify_rpc_failure(503, "", "server_schema_version");
    assert_eq!(
        err,
        SyncError::ServerRejected {
            status: 503,
            code: None,
            public_message: None,
        }
    );
    assert_eq!(
        err.to_string(),
        "The study server could not complete that request (HTTP 503)."
    );
}

#[test]
fn entitlement_token_maps_to_one_friendly_message() {
    use super::classify_rest_create_failure;
    use super::classify_rest_upsert_failure;

    let friendly = "Syncing new coding needs an active Fleuron subscription. \
     Your work is saved safely on this computer, and you can still pull your \
     team's latest — subscribe to resume syncing your own changes.";

    // 1. RPC path: 403 with the token in a nested PostgREST body.
    let body_403 =
        r#"{"code":"42501","message":"CODEMAP_ENTITLEMENT_REQUIRED","details":null,"hint":null}"#;
    let err = super::classify_rpc_failure(403, body_403, "sync_v2_apply");
    assert_eq!(
        err,
        SyncError::ServerRejected {
            status: 403,
            code: Some("CODEMAP_ENTITLEMENT_REQUIRED".into()),
            public_message: Some(friendly.into()),
        }
    );
    assert_eq!(err.to_string(), friendly);
    assert!(!err.to_string().contains("CODEMAP_ENTITLEMENT_REQUIRED"));
    assert!(!err.to_string().contains("42501"));

    // 2. RPC path: 400 nested JSON carrying the token (defensive parity with
    //    PostgREST wrapping) — same mapping, never the generic branch.
    let body_400 = r#"{"code":"P0001","message":"CODEMAP_ENTITLEMENT_REQUIRED","details":{"table":"codebook"}}"#;
    let err = super::classify_rpc_failure(400, body_400, "sync_v2_apply");
    assert_eq!(err.to_string(), friendly);

    // 3. Plain body (non-JSON) still containing the token.
    let err = super::classify_rpc_failure(403, "CODEMAP_ENTITLEMENT_REQUIRED", "join_group");
    assert_eq!(err.to_string(), friendly);

    // 4. Ordinary 403 stays the generic permission error.
    let err = super::classify_rpc_failure(
        403,
        r#"{"code":"42501","message":"You do not have permission"}"#,
        "delete_group",
    );
    assert_eq!(err, SyncError::PermissionDenied);

    // 5. Protocol-1 direct REST upsert path: same friendly message, never a
    //    Network("403: ...") wrapper.
    let err = classify_rest_upsert_failure(
        403,
        r#"{"code":"42501","message":"CODEMAP_ENTITLEMENT_REQUIRED"}"#.into(),
    );
    assert_eq!(err.to_string(), friendly);
    assert!(!matches!(err, SyncError::Network(_)));

    //    and it still preserves DuplicateCoding for ordinary conflicts.
    let err = classify_rest_upsert_failure(
        409,
        r#"{"code":"23505","message":"duplicate key value violates unique constraint\"coded_segments_span_unique\""}"#.into(),
    );
    assert!(matches!(err, SyncError::DuplicateCoding(_)));

    // 6. Direct project-create classification uses the exact same message.
    let err = classify_rest_create_failure(
        403,
        r#"{"code":"42501","message":"CODEMAP_ENTITLEMENT_REQUIRED","details":"new row violates row-level security policy for table \"projects\""}"#.into(),
    );
    assert_eq!(err.to_string(), friendly);
    assert!(!err.to_string().contains("row-level security"));

    // 7. The raw token and SQL/body details never appear in Display output.
    assert!(!err.to_string().contains("CODEMAP_ENTITLEMENT_REQUIRED"));
    assert!(!err.to_string().contains("row-level security"));
}

#[test]
fn rpc_body_key_validation() {
    let spec = RpcSpec {
        name: "test_rpc",
        args: &[
            RpcArg {
                name: "param1",
                sql_type: "text",
            },
            RpcArg {
                name: "param2",
                sql_type: "uuid",
            },
        ],
    };

    let valid_body = serde_json::json!({
        "param1": "val1",
        "param2": "11111111-1111-1111-1111-111111111111"
    });

    let obj = valid_body.as_object().unwrap();
    let expected: std::collections::HashSet<&str> = spec.args.iter().map(|a| a.name).collect();
    let actual: std::collections::HashSet<&str> = obj.keys().map(|s| s.as_str()).collect();
    assert_eq!(expected, actual);

    let missing_key = serde_json::json!({
        "param1": "val1"
    });
    let actual_missing: std::collections::HashSet<&str> = missing_key
        .as_object()
        .unwrap()
        .keys()
        .map(|s| s.as_str())
        .collect();
    assert_ne!(expected, actual_missing);

    let extra_key = serde_json::json!({
        "param1": "val1",
        "param2": "11111111-1111-1111-1111-111111111111",
        "extra": "leak"
    });
    let actual_extra: std::collections::HashSet<&str> = extra_key
        .as_object()
        .unwrap()
        .keys()
        .map(|s| s.as_str())
        .collect();
    assert_ne!(expected, actual_extra);
}
