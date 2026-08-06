const MAX_BOUNDED_JSON_BYTES_V1 = 16 * 1_024 * 1_024;

function failure(): Error {
  return new Error("The remote service returned an invalid bounded JSON response.");
}

async function cancelBody(response: Response) {
  await response.body?.cancel().catch(() => undefined);
}

/** Bounds untrusted Fetch response bytes before decoding or parsing JSON. */
export async function readBoundedJsonResponseV1(response: Response, maximumBytes: number): Promise<unknown> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > MAX_BOUNDED_JSON_BYTES_V1) {
    throw new RangeError("The bounded JSON response limit is invalid.");
  }
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && (!/^\d+$/u.test(declaredLength) || Number(declaredLength) > maximumBytes)) {
    await cancelBody(response);
    throw failure();
  }
  const reader = response.body?.getReader();
  if (!reader) throw failure();
  const chunks: Uint8Array[] = [];
  let byteSize = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteSize += value.byteLength;
      if (byteSize > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw failure();
      }
      chunks.push(value);
    }
  } catch {
    await reader.cancel().catch(() => undefined);
    throw failure();
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(byteSize);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw failure();
  }
}
