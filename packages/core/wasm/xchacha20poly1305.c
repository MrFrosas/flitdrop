// XChaCha20-Poly1305 (draft-irtf-cfrg-xchacha, RFC 8439) compilé en WebAssembly.
//
// Pourquoi : la page du téléphone est servie en HTTP simple sur le wifi. Safari
// y exécute le JavaScript sans compilateur rapide (JIT), et le chiffrement en
// JS pur (@noble/ciphers) y tombe à 1-3 Mo/s. Le même calcul en WebAssembly va
// environ 10 fois plus vite sans JIT, et 3 fois plus vite avec.
//
// Même construction, mêmes octets que @noble/ciphers xchacha20poly1305 :
//   sous-clé = HChaCha20(clé, nonce[0..16]) ; nonce12 = 0000 || nonce[16..24]
//   texte chiffré = ChaCha20(sous-clé, nonce12, compteur 1) XOR clair
//   tag = Poly1305(clé = ChaCha20(sous-clé, nonce12, compteur 0)[0..32],
//                  aad || pad16 || chiffré || pad16 || len(aad) || len(chiffré))
// Aucun changement de protocole : le PC et les anciennes pages ne voient pas
// la différence. Les tests (test/aead.test.ts) comparent chaque octet à noble
// et aux vecteurs publiés ; la page refait un test connu avant de s'en servir.
//
// Code sans table ni branche dépendant des secrets (ARX + Poly1305 « donna »
// 32 bits), comparaison du tag en temps constant, secrets de pile effacés.
// Compilation : node wasm/build.mjs (clang --target=wasm32, sans libc).
#include <stdint.h>
#include <stddef.h>

#define ROTL(a, b) (((a) << (b)) | ((a) >> (32 - (b))))
#define QR(a, b, c, d) \
  a += b; d ^= a; d = ROTL(d, 16); \
  c += d; b ^= c; b = ROTL(b, 12); \
  a += b; d ^= a; d = ROTL(d, 8);  \
  c += d; b ^= c; b = ROTL(b, 7);

static inline uint32_t ld32(const uint8_t *p) {
  return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}
static inline void st32(uint8_t *p, uint32_t v) {
  p[0] = (uint8_t)v; p[1] = (uint8_t)(v >> 8); p[2] = (uint8_t)(v >> 16); p[3] = (uint8_t)(v >> 24);
}

// effacement que le compilateur ne peut pas supprimer (pas d'appel à memset)
static void wipe(void *p, size_t n) {
  volatile uint8_t *v = (volatile uint8_t *)p;
  while (n--) *v++ = 0;
}

static void double_rounds(uint32_t x[16]) {
  for (int i = 0; i < 10; i++) {
    QR(x[0], x[4], x[8], x[12]) QR(x[1], x[5], x[9], x[13]) QR(x[2], x[6], x[10], x[14]) QR(x[3], x[7], x[11], x[15])
    QR(x[0], x[5], x[10], x[15]) QR(x[1], x[6], x[11], x[12]) QR(x[2], x[7], x[8], x[13]) QR(x[3], x[4], x[9], x[14])
  }
}

static void hchacha20(const uint8_t key[32], const uint8_t n16[16], uint8_t out[32]) {
  uint32_t x[16];
  x[0] = 0x61707865; x[1] = 0x3320646e; x[2] = 0x79622d32; x[3] = 0x6b206574;
  for (int i = 0; i < 8; i++) x[4 + i] = ld32(key + 4 * i);
  for (int i = 0; i < 4; i++) x[12 + i] = ld32(n16 + 4 * i);
  double_rounds(x);
  for (int i = 0; i < 4; i++) st32(out + 4 * i, x[i]);
  for (int i = 0; i < 4; i++) st32(out + 16 + 4 * i, x[12 + i]);
  wipe(x, sizeof x);
}

// XOR du flux ChaCha20 (compteur 32 bits, RFC 8439). `in` et `out` peuvent
// être la même zone : chaque mot est lu avant d'être écrit.
static void chacha20_xor(const uint8_t key[32], const uint8_t n12[12], uint32_t ctr, const uint8_t *in, uint8_t *out, size_t len) {
  uint32_t st[16], x[16];
  st[0] = 0x61707865; st[1] = 0x3320646e; st[2] = 0x79622d32; st[3] = 0x6b206574;
  for (int i = 0; i < 8; i++) st[4 + i] = ld32(key + 4 * i);
  st[12] = ctr;
  for (int i = 0; i < 3; i++) st[13 + i] = ld32(n12 + 4 * i);
  while (len > 0) {
    for (int i = 0; i < 16; i++) x[i] = st[i];
    double_rounds(x);
    for (int i = 0; i < 16; i++) x[i] += st[i];
    st[12]++;
    if (len >= 64) {
      for (int i = 0; i < 16; i++) st32(out + 4 * i, ld32(in + 4 * i) ^ x[i]);
      in += 64; out += 64; len -= 64;
    } else {
      uint8_t kb[64];
      for (int i = 0; i < 16; i++) st32(kb + 4 * i, x[i]);
      for (size_t i = 0; i < len; i++) out[i] = in[i] ^ kb[i];
      wipe(kb, sizeof kb);
      len = 0;
    }
  }
  wipe(x, sizeof x);
  wipe(st, sizeof st);
}

// ---- Poly1305, version « donna » 32 bits (5 membres de 26 bits) ----
typedef struct { uint32_t r[5], h[5], pad[4]; } poly1305;

static void poly_init(poly1305 *p, const uint8_t k[32]) {
  // r « clampé » (RFC 8439 2.5)
  p->r[0] = (ld32(k + 0)) & 0x3ffffff;
  p->r[1] = (ld32(k + 3) >> 2) & 0x3ffff03;
  p->r[2] = (ld32(k + 6) >> 4) & 0x3ffc0ff;
  p->r[3] = (ld32(k + 9) >> 6) & 0x3f03fff;
  p->r[4] = (ld32(k + 12) >> 8) & 0x00fffff;
  for (int i = 0; i < 5; i++) p->h[i] = 0;
  for (int i = 0; i < 4; i++) p->pad[i] = ld32(k + 16 + 4 * i);
}

// blocs de 16 octets complets, chacun avec le bit 2^128 (hibit)
static void poly_blocks(poly1305 *p, const uint8_t *m, size_t bytes) {
  const uint32_t hibit = 1u << 24;
  const uint32_t r0 = p->r[0], r1 = p->r[1], r2 = p->r[2], r3 = p->r[3], r4 = p->r[4];
  const uint32_t s1 = r1 * 5, s2 = r2 * 5, s3 = r3 * 5, s4 = r4 * 5;
  uint32_t h0 = p->h[0], h1 = p->h[1], h2 = p->h[2], h3 = p->h[3], h4 = p->h[4];
  while (bytes >= 16) {
    h0 += (ld32(m + 0)) & 0x3ffffff;
    h1 += (ld32(m + 3) >> 2) & 0x3ffffff;
    h2 += (ld32(m + 6) >> 4) & 0x3ffffff;
    h3 += (ld32(m + 9) >> 6) & 0x3ffffff;
    h4 += (ld32(m + 12) >> 8) | hibit;
    uint64_t d0 = (uint64_t)h0 * r0 + (uint64_t)h1 * s4 + (uint64_t)h2 * s3 + (uint64_t)h3 * s2 + (uint64_t)h4 * s1;
    uint64_t d1 = (uint64_t)h0 * r1 + (uint64_t)h1 * r0 + (uint64_t)h2 * s4 + (uint64_t)h3 * s3 + (uint64_t)h4 * s2;
    uint64_t d2 = (uint64_t)h0 * r2 + (uint64_t)h1 * r1 + (uint64_t)h2 * r0 + (uint64_t)h3 * s4 + (uint64_t)h4 * s3;
    uint64_t d3 = (uint64_t)h0 * r3 + (uint64_t)h1 * r2 + (uint64_t)h2 * r1 + (uint64_t)h3 * r0 + (uint64_t)h4 * s4;
    uint64_t d4 = (uint64_t)h0 * r4 + (uint64_t)h1 * r3 + (uint64_t)h2 * r2 + (uint64_t)h3 * r1 + (uint64_t)h4 * r0;
    uint32_t c;
    c = (uint32_t)(d0 >> 26); h0 = (uint32_t)d0 & 0x3ffffff;
    d1 += c; c = (uint32_t)(d1 >> 26); h1 = (uint32_t)d1 & 0x3ffffff;
    d2 += c; c = (uint32_t)(d2 >> 26); h2 = (uint32_t)d2 & 0x3ffffff;
    d3 += c; c = (uint32_t)(d3 >> 26); h3 = (uint32_t)d3 & 0x3ffffff;
    d4 += c; c = (uint32_t)(d4 >> 26); h4 = (uint32_t)d4 & 0x3ffffff;
    h0 += c * 5; c = h0 >> 26; h0 &= 0x3ffffff;
    h1 += c;
    m += 16; bytes -= 16;
  }
  p->h[0] = h0; p->h[1] = h1; p->h[2] = h2; p->h[3] = h3; p->h[4] = h4;
}

// données de longueur quelconque complétées de zéros jusqu'à 16 (AEAD RFC 8439)
static void poly_padded(poly1305 *p, const uint8_t *m, size_t len) {
  size_t full = len & ~(size_t)15;
  poly_blocks(p, m, full);
  if (len > full) {
    uint8_t b[16];
    for (int i = 0; i < 16; i++) b[i] = 0;
    for (size_t i = 0; i < len - full; i++) b[i] = m[full + i];
    poly_blocks(p, b, 16);
    wipe(b, sizeof b);
  }
}

static void poly_finish(poly1305 *p, uint8_t mac[16]) {
  uint32_t h0 = p->h[0], h1 = p->h[1], h2 = p->h[2], h3 = p->h[3], h4 = p->h[4], c, g0, g1, g2, g3, g4, mask;
  // propagation complète des retenues
  c = h1 >> 26; h1 &= 0x3ffffff;
  h2 += c; c = h2 >> 26; h2 &= 0x3ffffff;
  h3 += c; c = h3 >> 26; h3 &= 0x3ffffff;
  h4 += c; c = h4 >> 26; h4 &= 0x3ffffff;
  h0 += c * 5; c = h0 >> 26; h0 &= 0x3ffffff;
  h1 += c;
  // g = h + 5 - 2^130 ; on garde g si h >= p, sans branche
  g0 = h0 + 5; c = g0 >> 26; g0 &= 0x3ffffff;
  g1 = h1 + c; c = g1 >> 26; g1 &= 0x3ffffff;
  g2 = h2 + c; c = g2 >> 26; g2 &= 0x3ffffff;
  g3 = h3 + c; c = g3 >> 26; g3 &= 0x3ffffff;
  g4 = h4 + c - (1u << 26);
  mask = (g4 >> 31) - 1;
  g0 &= mask; g1 &= mask; g2 &= mask; g3 &= mask; g4 &= mask;
  mask = ~mask;
  h0 = (h0 & mask) | g0; h1 = (h1 & mask) | g1; h2 = (h2 & mask) | g2; h3 = (h3 & mask) | g3; h4 = (h4 & mask) | g4;
  // h mod 2^128, puis + s (pad)
  h0 = (h0 | (h1 << 26));
  h1 = ((h1 >> 6) | (h2 << 20));
  h2 = ((h2 >> 12) | (h3 << 14));
  h3 = ((h3 >> 18) | (h4 << 8));
  uint64_t f;
  f = (uint64_t)h0 + p->pad[0]; h0 = (uint32_t)f;
  f = (uint64_t)h1 + p->pad[1] + (f >> 32); h1 = (uint32_t)f;
  f = (uint64_t)h2 + p->pad[2] + (f >> 32); h2 = (uint32_t)f;
  f = (uint64_t)h3 + p->pad[3] + (f >> 32); h3 = (uint32_t)f;
  st32(mac + 0, h0); st32(mac + 4, h1); st32(mac + 8, h2); st32(mac + 12, h3);
  wipe(p, sizeof *p);
}

static void aead_tag(const uint8_t subkey[32], const uint8_t n12[12], const uint8_t *aad, size_t aadlen, const uint8_t *ct, size_t len, uint8_t tag[16]) {
  uint8_t block0[64];
  for (int i = 0; i < 64; i++) block0[i] = 0;
  chacha20_xor(subkey, n12, 0, block0, block0, 64);
  poly1305 p;
  poly_init(&p, block0);
  wipe(block0, sizeof block0);
  poly_padded(&p, aad, aadlen);
  poly_padded(&p, ct, len);
  uint8_t lens[16];
  st32(lens + 0, (uint32_t)aadlen); st32(lens + 4, (uint32_t)((uint64_t)aadlen >> 32));
  st32(lens + 8, (uint32_t)len); st32(lens + 12, (uint32_t)((uint64_t)len >> 32));
  poly_blocks(&p, lens, 16);
  poly_finish(&p, tag);
}

static void derive(const uint8_t key[32], const uint8_t n24[24], uint8_t subkey[32], uint8_t n12[12]) {
  hchacha20(key, n24, subkey);
  n12[0] = n12[1] = n12[2] = n12[3] = 0;
  for (int i = 0; i < 8; i++) n12[4 + i] = n24[16 + i];
}

// Chiffre `len` octets de `in` vers `out` (même zone permise), puis écrit le
// tag de 16 octets juste après : out = chiffré (len) || tag (16).
__attribute__((export_name("xcp_seal")))
void xcp_seal(const uint8_t *key, const uint8_t *n24, const uint8_t *aad, size_t aadlen, const uint8_t *in, size_t len, uint8_t *out) {
  uint8_t subkey[32], n12[12];
  derive(key, n24, subkey, n12);
  chacha20_xor(subkey, n12, 1, in, out, len);
  aead_tag(subkey, n12, aad, aadlen, out, len, out + len);
  wipe(subkey, sizeof subkey);
}

// `in` = chiffré (len) || tag (16). Renvoie 0 et le clair dans `out` (même
// zone permise) si le tag est bon ; -1 sinon, et rien n'est déchiffré.
__attribute__((export_name("xcp_open")))
int xcp_open(const uint8_t *key, const uint8_t *n24, const uint8_t *aad, size_t aadlen, const uint8_t *in, size_t len, uint8_t *out) {
  uint8_t subkey[32], n12[12], tag[16];
  derive(key, n24, subkey, n12);
  aead_tag(subkey, n12, aad, aadlen, in, len, tag);
  uint32_t d = 0;
  for (int i = 0; i < 16; i++) d |= (uint32_t)(tag[i] ^ in[len + i]);
  wipe(tag, sizeof tag);
  // d vaut 0 seulement si les 16 octets sont égaux (aucune sortie anticipée)
  int ok = (int)((d - 1) >> 31) & 1;
  if (ok) chacha20_xor(subkey, n12, 1, in, out, len);
  wipe(subkey, sizeof subkey);
  return ok ? 0 : -1;
}
