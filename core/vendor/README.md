# Vendored crates

| Crate | Why | Change |
| --- | --- | --- |
| `glib` 0.18.5 | Fixes [RUSTSEC-2024-0429](https://rustsec.org/advisories/RUSTSEC-2024-0429) for Linux builds; tauri still needs glib 0.18 and the fix shipped only in 0.20. | `src/variant_iter.rs`: the pointer `g_variant_get_child` writes is now `mut` and passed as `&mut p`, as upstream did. |

Delete a crate here, and its `[patch.crates-io]` line in `Cargo.toml`, once tauri depends on a fixed version.
