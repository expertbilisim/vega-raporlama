"use strict";

const {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} = require("node:crypto");

const URUN = "vega-raporlama";
const VARSAYILAN_ADRES = "https://lisans.expertbilisim.com.tr";

function bugun(simdi = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Istanbul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(simdi);
}

function tarihYazi(iso) {
  const eslesen = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ""));
  if (!eslesen) return "";
  return `${eslesen[3]}.${eslesen[2]}.${eslesen[1]}`;
}

function anahtarUret() {
  return generateKeyPairSync("ed25519");
}

function acikAnahtarYaz(publicKey) {
  return publicKey.export({ type: "spki", format: "der" }).toString("base64");
}

function acikAnahtarOku(b64) {
  return createPublicKey({
    key: Buffer.from(String(b64 || ""), "base64"),
    type: "spki",
    format: "der",
  });
}

function ozelAnahtarOku(pem) {
  return createPrivateKey(pem);
}

function ozelAnahtarPem(privateKey) {
  return privateKey.export({ type: "pkcs8", format: "pem" });
}

function acikAnahtariTuret(privateKey) {
  return createPublicKey(privateKey);
}

function anahtarParmak(b64) {
  return createHash("sha256").update(Buffer.from(String(b64 || ""), "base64")).digest("hex").slice(0, 12);
}

function vrlUret(payload, privateKey) {
  const govde = {
    surum: 1,
    urun: URUN,
    kurulumId: String(payload.kurulumId || "").trim().toLowerCase(),
    bitis: String(payload.bitis || "").trim(),
    verilme: payload.verilme || new Date().toISOString(),
  };
  if (!/^[a-z0-9-]{8,80}$/.test(govde.kurulumId) || !/^\d{4}-\d{2}-\d{2}$/.test(govde.bitis)) {
    throw new Error("Lisans alanları eksik.");
  }
  const satir = Buffer.from(JSON.stringify(govde), "utf8").toString("base64url");
  const imza = sign(null, Buffer.from(satir, "utf8"), privateKey);
  return `VRL1\n${satir}\n${Buffer.from(imza).toString("base64url")}\n`;
}

function vrlCoz(metin, acikAnahtarB64, kurulumId, simdi = new Date()) {
  const satirlar = String(metin || "")
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((satir) => satir.trim())
    .filter((satir) => satir.length);
  if (satirlar.length !== 3 || satirlar[0] !== "VRL1") {
    return { ok: false, mesaj: "Lisans dosyası bozuk." };
  }
  let anahtar;
  try {
    anahtar = acikAnahtarOku(acikAnahtarB64);
  } catch {
    return { ok: false, mesaj: "Lisans dosyası bozuk." };
  }
  let imza;
  try {
    imza = Buffer.from(satirlar[2], "base64url");
  } catch {
    return { ok: false, mesaj: "Lisans dosyası bozuk." };
  }
  if (!verify(null, Buffer.from(satirlar[1], "utf8"), anahtar, imza)) {
    return { ok: false, mesaj: "Lisans dosyası bozuk." };
  }
  let govde;
  try {
    govde = JSON.parse(Buffer.from(satirlar[1], "base64url").toString("utf8"));
  } catch {
    return { ok: false, mesaj: "Lisans dosyası bozuk." };
  }
  if (!govde || govde.urun !== URUN || govde.surum !== 1 || !/^\d{4}-\d{2}-\d{2}$/.test(govde.bitis || "")) {
    return { ok: false, mesaj: "Lisans dosyası bozuk." };
  }
  const gelen = String(govde.kurulumId || "").trim().toLowerCase();
  const beklenen = String(kurulumId || "").trim().toLowerCase();
  if (!gelen || gelen !== beklenen) {
    return { ok: false, mesaj: "Bu lisans dosyası bu bilgisayar için değil." };
  }
  if (govde.bitis < bugun(simdi)) {
    return { ok: false, mesaj: "Bu lisansın süresi dolmuş.", bitis: govde.bitis };
  }
  return {
    ok: true,
    gecerli: true,
    bitis: govde.bitis,
    kurulumId: gelen,
    mesaj: "Lisans geçerli. Bitiş: " + tarihYazi(govde.bitis),
  };
}

module.exports = {
  URUN,
  VARSAYILAN_ADRES,
  bugun,
  tarihYazi,
  anahtarUret,
  acikAnahtarYaz,
  acikAnahtarOku,
  ozelAnahtarOku,
  ozelAnahtarPem,
  acikAnahtariTuret,
  anahtarParmak,
  vrlUret,
  vrlCoz,
};
