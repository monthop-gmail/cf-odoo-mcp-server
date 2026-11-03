// Node ไม่มี timingSafeEqual บน crypto.subtle (Workers มี) — secretsMatch ใช้มัน
const subtle = crypto.subtle as SubtleCrypto & {
  timingSafeEqual?: (a: ArrayBufferView, b: ArrayBufferView) => boolean;
};
subtle.timingSafeEqual ??= (a, b) =>
  a.byteLength === b.byteLength &&
  Buffer.compare(
    Buffer.from(a.buffer, a.byteOffset, a.byteLength),
    Buffer.from(b.buffer, b.byteOffset, b.byteLength),
  ) === 0;
