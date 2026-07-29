use std::io::{self, BufRead, Write};

use poietra_mathtex_wasm::compile_mathtex_outline_json_v1;

fn main() -> io::Result<()> {
    let stdin = io::stdin();
    let mut stdout = io::stdout().lock();
    for request in stdin.lock().split(b'\n') {
        let request = request?;
        if request.is_empty() {
            continue;
        }
        stdout.write_all(&compile_mathtex_outline_json_v1(&request))?;
        stdout.write_all(b"\n")?;
    }
    Ok(())
}
