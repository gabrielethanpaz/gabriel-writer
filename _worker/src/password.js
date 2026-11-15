// Password hashing shared by the login service and add-user.mjs
const encoder = new TextEncoder();
export const ITERATIONS = 100000; // the most Cloudflare Workers allow

export async function hashPassword(password, salt, iterations = ITERATIONS) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: encoder.encode(salt), iterations }, key, 256);
  return btoa(String.fromCharCode(...new Uint8Array(bits)));
}
