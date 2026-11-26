"use strict";

const { spawn, execFileSync } = require("node:child_process");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const kok = join(__dirname, "..");

function bekle(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function iste(url, options) {
  const yanit = await fetch(url, options);
  const tur = yanit.headers.get("content-type") || "";
  const body = tur.includes("json")
    ? await yanit.json().catch(() => ({}))
    : await yanit.text();
  return { status: yanit.status, body };
}

async function hazir(url) {
  let son = "";
  for (let i = 0; i < 50; i += 1) {
    try {
      const yanit = await fetch(url);
      if (yanit.status) return;
    } catch (error) {
      son = error.message;
    }
    await bekle(100);
  }
  throw new Error("Sunucu açılmadı: " + url + " " + son);
}

function dur(child) {
  if (!child || child.killed) return;
  child.kill("SIGKILL");
}

async function main() {
  execFileSync(process.execPath, ["--check", join(kok, "lisans.js")], { stdio: "inherit" });
  execFileSync(process.execPath, ["--check", join(kok, "lisans-site", "server.js")], { stdio: "inherit" });
  execFileSync(process.execPath, ["--check", join(kok, "server.js")], { stdio: "inherit" });
  execFileSync(process.execPath, [join(kok, "scripts", "build-sea.js"), "--yalniz-paket"], { cwd: kok, stdio: "inherit" });
  execFileSync(process.execPath, ["--check", join(kok, "dist", "sea-server.js")], { stdio: "inherit" });

  const veri = mkdtempSync(join(tmpdir(), "lisans-veri-"));
  const uygulama = mkdtempSync(join(tmpdir(), "vega-kurulum-"));
  const lisansPort = 21000 + Math.floor(Math.random() * 10000);
  const uygulamaPort = lisansPort + 1;
  const lisansAdres = `http://127.0.0.1:${lisansPort}`;
  const uygulamaAdres = `http://127.0.0.1:${uygulamaPort}`;
  const site = spawn(process.execPath, ["lisans-site/server.js"], {
    cwd: kok,
    env: { ...process.env, PORT: String(lisansPort), HOST: "127.0.0.1", LISANS_VERI: veri },
    stdio: "ignore",
  });
  const app = spawn(process.execPath, ["server.js"], {
    cwd: kok,
    env: {
      ...process.env,
      PORT: String(uygulamaPort),
      LISANS_ADRES: lisansAdres,
      LOCALAPPDATA: uygulama,
      VEGA_PENCERE: "0",
      VEGA_KONSOL: "1",
    },
    stdio: "ignore",
  });
  try {
    await hazir(lisansAdres + "/api/acik-anahtar");
    await hazir(uygulamaAdres + "/api/lisans");

    const sayfa = await iste(uygulamaAdres + "/");
    if (sayfa.status !== 200 || !String(sayfa.body).includes("Dosya seç") || !String(sayfa.body).includes(">Tamam<")) {
      throw new Error("Uygulama sayfasında Dosya seç veya Tamam yok.");
    }

    let durum = await iste(uygulamaAdres + "/api/lisans");
    if (durum.status !== 200 || durum.body.gecerli !== false) {
      throw new Error("Lisanssız kurulum açık geldi: " + JSON.stringify(durum.body));
    }
    const kurulumId = durum.body.kurulumId;
    if (!kurulumId) throw new Error("Kurulum kimliği yok.");

    const kapali = await iste(uygulamaAdres + "/api/giris", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    if (kapali.status !== 403) throw new Error("Süresi dolan kurulum girişe izin verdi: " + kapali.status);

    let kurulumlar = [];
    for (let i = 0; i < 20; i += 1) {
      await iste(uygulamaAdres + "/api/lisans");
      const liste = await iste(lisansAdres + "/api/kurulumlar");
      kurulumlar = liste.body.kurulumlar || [];
      if (kurulumlar.some((item) => item.kurulumId === kurulumId)) break;
      await bekle(150);
    }
    if (!kurulumlar.some((item) => item.kurulumId === kurulumId)) {
      throw new Error("Kurulum lisans sayfasına düşmedi.");
    }
    const html = await iste(lisansAdres + "/");
    if (!String(html.body).includes("Dosya indir") || !String(html.body).includes(kurulumId)) {
      throw new Error("Lisans sayfasında kurulum veya Dosya indir yok.");
    }

    const gecerliDosya = await iste(`${lisansAdres}/api/dosya?kurulum=${kurulumId}&bitis=2099-01-01`);
    if (gecerliDosya.status !== 200 || !String(gecerliDosya.body).startsWith("VRL1\n")) {
      throw new Error("Dosya indirilemedi: " + gecerliDosya.status);
    }
    const yuklendi = await iste(uygulamaAdres + "/api/lisans", {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: gecerliDosya.body,
    });
    if (yuklendi.status !== 200 || !yuklendi.body.gecerli || !String(yuklendi.body.mesaj).includes("01.01.2099")) {
      throw new Error("Geçerli dosya kabul edilmedi: " + JSON.stringify(yuklendi.body));
    }

    const satirlar = String(gecerliDosya.body).trim().split("\n");
    satirlar[2] = (satirlar[2].startsWith("A") ? "B" : "A") + satirlar[2].slice(1);
    const bozuk = await iste(uygulamaAdres + "/api/lisans", {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: satirlar.join("\n") + "\n",
    });
    if (bozuk.status !== 400 || bozuk.body.error !== "Lisans dosyası bozuk.") {
      throw new Error("Bozuk dosya reddedilmedi: " + JSON.stringify(bozuk.body));
    }

    const baskaId = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    await iste(lisansAdres + "/api/kurulum", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ urun: "vega-raporlama", kurulumId: baskaId, makine: "Baska", surum: "1.2.14" }),
    });
    const baskaDosya = await iste(`${lisansAdres}/api/dosya?kurulum=${baskaId}&bitis=2099-01-01`);
    const baska = await iste(uygulamaAdres + "/api/lisans", {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: baskaDosya.body,
    });
    if (baska.status !== 400 || baska.body.error !== "Bu lisans dosyası bu bilgisayar için değil.") {
      throw new Error("Başka bilgisayar dosyası reddedilmedi: " + JSON.stringify(baska.body));
    }

    const eskiDosya = await iste(`${lisansAdres}/api/dosya?kurulum=${kurulumId}&bitis=2000-01-01`);
    const eski = await iste(uygulamaAdres + "/api/lisans", {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: eskiDosya.body,
    });
    if (eski.status !== 400 || eski.body.error !== "Bu lisansın süresi dolmuş.") {
      throw new Error("Süresi dolmuş dosya reddedilmedi: " + JSON.stringify(eski.body));
    }

    durum = await iste(uygulamaAdres + "/api/lisans");
    if (!durum.body.gecerli) throw new Error("Reddedilen dosya geçerli lisansı sildi.");

    const acik = await iste(uygulamaAdres + "/api/giris", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kullanici: "yok", sifre: "", firma: 1, donem: 1 }),
      signal: AbortSignal.timeout(15000),
    });
    if (acik.status === 403) throw new Error("Geçerli lisans giriş kapısını açmadı.");

    console.log("Lisans akışı tamam.");
  } finally {
    dur(site);
    dur(app);
    rmSync(veri, { recursive: true, force: true });
    rmSync(uygulama, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error && error.stack || error);
  process.exit(1);
});
