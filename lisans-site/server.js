"use strict";

// Plesk uygulama kökü bu dosyanın bir üst klasörü olmalı (lisans.js orada durur).
// Başlangıç dosyası: lisans-site/server.js
// İlk çalışmada data/ozel-anahtar.pem oluşur; silinirse imza değişir.

const { createServer } = require("node:http");
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const lisans = require("../lisans.js");

const PORT = Number(process.env.PORT || 8780);
const HOST = process.env.HOST || "0.0.0.0";
const VERI = process.env.LISANS_VERI || join(__dirname, "data");
const ANAHTAR_DOSYA = join(VERI, "ozel-anahtar.pem");
const KURULUM_DOSYA = join(VERI, "kurulumlar.json");

function okuGovde(req, limit) {
  return new Promise((resolve, reject) => {
    const parca = [];
    let boyut = 0;
    req.on("data", (buf) => {
      boyut += buf.length;
      if (boyut > limit) {
        reject(new Error("İstek çok büyük."));
        req.destroy();
        return;
      }
      parca.push(buf);
    });
    req.on("end", () => {
      if (!parca.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(parca).toString("utf8")));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function json(res, status, body) {
  const raw = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(raw);
}

function htmlKac(deger) {
  return String(deger ?? "").replace(/[&<>"']/g, (karakter) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  }[karakter]));
}

function kurulumlariOku() {
  try {
    const veri = JSON.parse(readFileSync(KURULUM_DOSYA, "utf8"));
    if (veri && typeof veri === "object" && !Array.isArray(veri)) return veri;
  } catch { /* ilk açılış */ }
  return {};
}

function kurulumlariYaz(liste) {
  mkdirSync(VERI, { recursive: true });
  writeFileSync(KURULUM_DOSYA, JSON.stringify(liste, null, 2));
}

function ozelAnahtarYukle() {
  mkdirSync(VERI, { recursive: true });
  if (existsSync(ANAHTAR_DOSYA)) return lisans.ozelAnahtarOku(readFileSync(ANAHTAR_DOSYA, "utf8"));
  const cift = lisans.anahtarUret();
  writeFileSync(ANAHTAR_DOSYA, lisans.ozelAnahtarPem(cift.privateKey), { mode: 0o600 });
  return cift.privateKey;
}

const ozelAnahtar = ozelAnahtarYukle();
const acikAnahtar = lisans.acikAnahtarYaz(lisans.acikAnahtariTuret(ozelAnahtar));
const parmak = lisans.anahtarParmak(acikAnahtar);

function kurulumIdTemiz(deger) {
  const id = String(deger || "").trim().toLowerCase();
  return /^[a-z0-9-]{8,80}$/.test(id) ? id : "";
}

function makineTemiz(deger) {
  return String(deger || "").replace(/[\u0000-\u001f]/g, "").trim().slice(0, 80);
}

function tarihGecerli(deger) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(deger || ""));
}

function birYilSonra() {
  const [yil, ay, gun] = lisans.bugun().split("-").map(Number);
  const tarih = new Date(Date.UTC(yil + 1, ay - 1, gun));
  return tarih.toISOString().slice(0, 10);
}

function saatYazi(iso) {
  if (!iso) return "";
  const tarih = new Date(iso);
  if (Number.isNaN(tarih.getTime())) return "";
  return new Intl.DateTimeFormat("tr-TR", {
    timeZone: "Europe/Istanbul",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(tarih);
}

function sayfa() {
  const liste = Object.values(kurulumlariOku())
    .filter((item) => item && item.kurulumId)
    .sort((a, b) => String(b.gorulme || "").localeCompare(String(a.gorulme || "")));
  const varsayilan = birYilSonra();
  const satirlar = liste.length
    ? liste.map((item) => {
      const bitis = tarihGecerli(item.bitis) ? item.bitis : varsayilan;
      const id = htmlKac(item.kurulumId);
      return `<tr>
        <td><b>${htmlKac(item.makine || "Bilgisayar")}</b><br><span class="soluk">${id}</span></td>
        <td>Vega Raporlama<br><span class="soluk">v${htmlKac(item.surum || "")}</span></td>
        <td>${htmlKac(saatYazi(item.gorulme) || "—")}</td>
        <td>${item.bitis ? htmlKac(lisans.tarihYazi(item.bitis)) : "—"}</td>
        <td>
          <form method="get" action="/api/dosya">
            <input type="hidden" name="kurulum" value="${id}">
            <input type="date" name="bitis" value="${htmlKac(bitis)}" required aria-label="Bitiş">
            <button type="submit">Dosya indir</button>
          </form>
        </td>
      </tr>`;
    }).join("")
    : `<tr><td colspan="5" class="bos">Henüz kurulum yok. Vega Raporlama bu adrese bağlandığında kurulum burada görünür.</td></tr>`;
  return `<!DOCTYPE html>
<html lang="tr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Lisans · Expert Bilişim</title>
  <style>
    body { margin: 0; font: 15px "Segoe UI", sans-serif; background: #f4f8fb; color: #1d2430; }
    header { padding: 22px 28px 8px; }
    h1 { margin: 0; font-size: 26px; }
    p { margin: 8px 0 0; color: #5c6b7a; max-width: 720px; }
    .anahtar { margin: 8px 0 0; font-size: 12px; color: #8a9099; }
    main { padding: 8px 28px 32px; }
    table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #d5dde5; }
    th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid #e4ebf0; vertical-align: middle; }
    th { font-size: 12px; color: #5c6b7a; font-weight: 650; }
    .soluk { color: #8a9099; font-size: 12px; font-weight: 500; word-break: break-all; }
    .bos { color: #5c6b7a; padding: 22px 12px; }
    form { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    input[type="date"] { border: 1px solid #b7c9d2; border-radius: 8px; padding: 6px 8px; font: inherit; }
    button { border: 1px solid #1f7f8c; background: #1f7f8c; color: #fff; border-radius: 8px; padding: 7px 12px; font: inherit; font-weight: 650; cursor: pointer; }
  </style>
</head>
<body>
  <header>
    <h1>Lisans</h1>
    <p>Her satır bir Vega Raporlama kurulumu. Dosya indir ile imzalı .vrl alınır; dosya yalnızca o kuruluma aittir. Vega Raporlama içinde Dosya seç ile açılır.</p>
    <p class="anahtar">İmza anahtarı: ${htmlKac(parmak)}. Bu anahtarın dosyası silinirse daha önce indirilen lisanslar geçersiz olur.</p>
  </header>
  <main>
    <table>
      <thead>
        <tr><th>Kurulum</th><th>Ürün</th><th>Son görülme</th><th>Süre</th><th>Dosya</th></tr>
      </thead>
      <tbody>${satirlar}</tbody>
    </table>
  </main>
</body>
</html>`;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  try {
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/lisans")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(sayfa());
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/acik-anahtar") {
      json(res, 200, { urun: lisans.URUN, anahtar: acikAnahtar, parmak });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/kurulumlar") {
      json(res, 200, { kurulumlar: Object.values(kurulumlariOku()) });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/kurulum") {
      const body = await okuGovde(req, 16 * 1024);
      const kurulumId = kurulumIdTemiz(body.kurulumId);
      if (body.urun !== lisans.URUN || !kurulumId) {
        json(res, 400, { error: "Kurulum bilgisi eksik." });
        return;
      }
      const liste = kurulumlariOku();
      const once = liste[kurulumId] || {};
      liste[kurulumId] = {
        kurulumId,
        urun: lisans.URUN,
        makine: makineTemiz(body.makine) || once.makine || "Bilgisayar",
        surum: String(body.surum || once.surum || "").slice(0, 20),
        gorulme: new Date().toISOString(),
        bitis: once.bitis || "",
      };
      kurulumlariYaz(liste);
      json(res, 200, { ok: true });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/dosya") {
      const kurulumId = kurulumIdTemiz(url.searchParams.get("kurulum"));
      const bitis = String(url.searchParams.get("bitis") || "");
      const liste = kurulumlariOku();
      const kayit = kurulumId && liste[kurulumId];
      if (!kayit) {
        json(res, 404, { error: "Kurulum yok." });
        return;
      }
      if (!tarihGecerli(bitis)) {
        json(res, 400, { error: "Bitiş tarihi seçin." });
        return;
      }
      const dosya = lisans.vrlUret({ kurulumId, bitis }, ozelAnahtar);
      liste[kurulumId] = { ...kayit, bitis };
      kurulumlariYaz(liste);
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": "attachment; filename=\"vega-raporlama.vrl\"",
        "Cache-Control": "no-store",
      });
      res.end(dosya);
      return;
    }

    json(res, 404, { error: "Sayfa yok." });
  } catch (error) {
    json(res, 500, { error: error.message || "Sunucu hatası" });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Lisans http://${HOST}:${PORT} anahtar ${parmak}`);
});
