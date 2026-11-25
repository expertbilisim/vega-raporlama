const { execFile, execFileSync, spawn } = require("node:child_process");
const { createHash, randomBytes } = require("node:crypto");
const { copyFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync, unlinkSync, rmSync } = require("node:fs");
const { createServer } = require("node:http");
const { networkInterfaces, tmpdir } = require("node:os");
const { basename, dirname, join } = require("node:path");
const { pathToFileURL } = require("node:url");
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);
const PORT = Number(process.env.PORT || 3850);
const UYGULAMA_SURUM = "1.2.10";
const GUNCELLEME_REPO = "expertbilisim/vega-raporlama";
const guncellemeDurum = {
  durum: "bekliyor",
  surum: UYGULAMA_SURUM,
  yeniSurum: "",
  mesaj: "",
  zaman: null,
};

function teklifPbKod(value) {
  const gelen = String(value || "").trim();
  const ust = gelen.toUpperCase();
  if (gelen === "$" || ust === "USD" || ust === "DOLAR") return "$";
  if (ust === "EUR" || ust === "EURO" || gelen === "€") return "EUR";
  return "TL";
}

function dovizGunIfade(value) {
  const yazi = String(value || "").trim();
  let gun = "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(yazi)) {
    const [yil, ay, tarih] = yazi.split("-");
    gun = `${tarih}.${ay}.${yil}`;
  } else if (/^\d{2}\.\d{2}\.\d{4}$/.test(yazi)) {
    gun = yazi;
  }
  return gun ? `CONVERT(datetime, N'${gun}', 104)` : "";
}

function tcmbTarihYol(value) {
  const yazi = String(value || "").trim();
  let yil = "";
  let ay = "";
  let gun = "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(yazi)) [yil, ay, gun] = yazi.split("-");
  else if (/^\d{2}\.\d{2}\.\d{4}$/.test(yazi)) [gun, ay, yil] = yazi.split(".");
  if (!yil) return "";
  return `${yil}${ay}/${gun}${ay}${yil}.xml`;
}

function tcmbPbKod(pb) {
  const kod = teklifPbKod(pb);
  if (kod === "$") return "USD";
  if (kod === "EUR") return "EUR";
  return "";
}

async function tcmbKurOku(pb, tarih) {
  const yol = tcmbTarihYol(tarih);
  const kod = tcmbPbKod(pb);
  if (!yol || !kod) return { bulundu: false, mesaj: "Tarih ve para birimi seçin." };
  let yanit;
  try {
    yanit = await fetch(`https://www.tcmb.gov.tr/kurlar/${yol}`, {
      headers: { Accept: "application/xml,text/xml,*/*", "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(12000),
    });
  } catch {
    return { bulundu: false, mesaj: "Merkez Bankası'na ulaşılamadı. Kuru elle yazın." };
  }
  if (!yanit.ok) return { bulundu: false, mesaj: "Merkez Bankası bu gün için kur yayımlamamış. Kuru elle yazın." };
  const xml = await yanit.text();
  const blok = xml.match(new RegExp(`<Currency[^>]*CurrencyCode="${kod}"[\\s\\S]*?</Currency>`, "i"));
  if (!blok) return { bulundu: false, mesaj: "Merkez Bankası bu para birimini yayımlamamış. Kuru elle yazın." };
  const satis = blok[0].match(/<ForexSelling>([\d.]+)<\/ForexSelling>/i)
    || blok[0].match(/<BanknoteSelling>([\d.]+)<\/BanknoteSelling>/i);
  const birim = Number((blok[0].match(/<Unit>(\d+)<\/Unit>/i) || [])[1]) || 1;
  const kur = Number(satis && satis[1]) / birim;
  if (!Number.isFinite(kur) || kur <= 0) return { bulundu: false, mesaj: "Merkez Bankası bu gün için kur yayımlamamış. Kuru elle yazın." };
  return { bulundu: true, kur };
}

function piyasaSayi(value) {
  let yazi = String(value || "").trim().replace(/[^\d,.-]/g, "");
  if (!yazi) return null;
  if (yazi.includes(",") && yazi.includes(".")) yazi = yazi.replace(/\./g, "").replace(",", ".");
  else if (yazi.includes(",")) yazi = yazi.replace(",", ".");
  const sayi = Number(yazi);
  return Number.isFinite(sayi) && sayi > 0 ? sayi : null;
}

let piyasaOnbellek = { zaman: 0, veri: null };

async function piyasaGetir() {
  if (piyasaOnbellek.veri && Date.now() - piyasaOnbellek.zaman < 15 * 60 * 1000) return piyasaOnbellek.veri;
  let yanit;
  try {
    yanit = await fetch("https://finans.truncgil.com/today.json", {
      headers: { Accept: "application/json", "User-Agent": "VegaRaporlama/" + UYGULAMA_SURUM },
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    if (piyasaOnbellek.veri) return piyasaOnbellek.veri;
    return { hata: "Kur alınamadı." };
  }
  if (!yanit.ok) {
    if (piyasaOnbellek.veri) return piyasaOnbellek.veri;
    return { hata: "Kur alınamadı." };
  }
  const data = await yanit.json();
  const kalem = (ad, blok, birim) => ({
    ad,
    birim,
    alis: piyasaSayi(blok?.["Alış"] ?? blok?.Alis),
    satis: piyasaSayi(blok?.["Satış"] ?? blok?.Satis),
  });
  const veri = {
    zaman: String(data.Update_Date || ""),
    kalemler: [
      kalem("Dolar", data.USD, "USD"),
      kalem("Euro", data.EUR, "EUR"),
      kalem("Sterlin", data.GBP, "GBP"),
      kalem("Altın", data["gram-altin"], "gr"),
    ],
  };
  if (!veri.kalemler.some((item) => item.satis)) {
    if (piyasaOnbellek.veri) return piyasaOnbellek.veri;
    return { hata: "Kur alınamadı." };
  }
  piyasaOnbellek = { zaman: Date.now(), veri };
  return veri;
}

function dovizEslesme(pb) {
  const kod = teklifPbKod(pb);
  if (kod === "$") {
    return `(
      REPLACE(UPPER(LTRIM(RTRIM(ISNULL(d.DOVIZSEMBOLU, N'')))), N' ', N'') IN (N'$', N'USD', N'US$')
      OR UPPER(LTRIM(RTRIM(ISNULL(d.DOVIZCINSI, N'')))) IN (N'USD', N'DOLAR', N'ABD DOLARI', N'AMERIKAN DOLARI')
    )`;
  }
  if (kod === "EUR") {
    return `(
      REPLACE(UPPER(LTRIM(RTRIM(ISNULL(d.DOVIZSEMBOLU, N'')))), N' ', N'') IN (N'€', N'EUR', N'EURO')
      OR UPPER(LTRIM(RTRIM(ISNULL(d.DOVIZCINSI, N'')))) IN (N'EUR', N'EURO', N'AVRO')
    )`;
  }
  return "";
}

function ilkVarolan(adaylar) {
  return adaylar.find((yol) => yol && existsSync(yol)) || "";
}

function udlBul() {
  if (process.env.VEGA_UDL) return process.env.VEGA_UDL;
  const pf86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const pf = process.env.ProgramFiles || "C:\\Program Files";
  const ad = join("Common Files", "System", "Ole DB", "Data Links", "vegacon.udl");
  return ilkVarolan([
    join(dirname(process.execPath), "vegacon.udl"),
    join(pf86, ad),
    join(pf, ad),
  ]) || join(pf86, ad);
}

function sqlcmdBul() {
  if (process.env.SQLCMD) return existsSync(process.env.SQLCMD) ? process.env.SQLCMD : "";
  const pf = process.env.ProgramFiles || "C:\\Program Files";
  const pf86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const surumler = ["180", "170", "160", "150", "140", "130", "120", "110"];
  const adaylar = [];
  for (const kok of [pf, pf86]) {
    for (const surum of surumler) {
      adaylar.push(join(kok, "Microsoft SQL Server", "Client SDK", "ODBC", surum, "Tools", "Binn", "SQLCMD.EXE"));
      adaylar.push(join(kok, "Microsoft SQL Server", surum, "Tools", "Binn", "SQLCMD.EXE"));
    }
  }
  const bulunan = ilkVarolan(adaylar);
  if (bulunan) return bulunan;
  try {
    const { execFileSync } = require("node:child_process");
    const cikti = execFileSync("where.exe", ["sqlcmd"], { encoding: "utf8", windowsHide: true });
    const satir = cikti.split(/\r?\n/).map((satir) => satir.trim()).find((satir) => satir && existsSync(satir));
    if (satir) return satir;
  } catch {
    // sqlcmd yüklü değil
  }
  return "";
}

const UDL = udlBul();
const SQLCMD = sqlcmdBul();

const CP857 = [
  0x00c7, 0x00fc, 0x00e9, 0x00e2, 0x00e4, 0x00e0, 0x00e5, 0x00e7, 0x00ea, 0x00eb, 0x00e8, 0x00ef, 0x00ee, 0x0131, 0x00c4, 0x00c5,
  0x00c9, 0x00e6, 0x00c6, 0x00f4, 0x00f6, 0x00f2, 0x00fb, 0x00f9, 0x0130, 0x00d6, 0x00dc, 0x00f8, 0x00a3, 0x00d8, 0x015e, 0x015f,
  0x00e1, 0x00ed, 0x00f3, 0x00fa, 0x00f1, 0x00d1, 0x011e, 0x011f, 0x00bf, 0x00ae, 0x00ac, 0x00bd, 0x00bc, 0x00a1, 0x00ab, 0x00bb,
  0x2591, 0x2592, 0x2593, 0x2502, 0x2524, 0x00c1, 0x00c2, 0x00c0, 0x00a9, 0x2563, 0x2551, 0x2557, 0x255d, 0x00a2, 0x00a5, 0x2510,
  0x2514, 0x2534, 0x252c, 0x251c, 0x2500, 0x253c, 0x00e3, 0x00c3, 0x255a, 0x2554, 0x2569, 0x2566, 0x2560, 0x2550, 0x256c, 0x00a4,
  0x00ba, 0x00aa, 0x00ca, 0x00cb, 0x00c8, 0xf8bb, 0x00cd, 0x00ce, 0x00cf, 0x2518, 0x250c, 0x2588, 0x2584, 0x00a6, 0x00cc, 0x2580,
  0x00d3, 0x00df, 0x00d4, 0x00d2, 0x00f5, 0x00d5, 0x00b5, 0xf8bc, 0x00d7, 0x00da, 0x00db, 0x00d9, 0x00ec, 0x00ff, 0x00af, 0x00b4,
  0x00ad, 0x00b1, 0xf8bd, 0x00be, 0x00b6, 0x00a7, 0x00f7, 0x00b8, 0x00b0, 0x00a8, 0x00b7, 0x00b9, 0x00b3, 0x00b2, 0x25a0, 0x00a0,
];

function readUdl() {
  try {
    const buffer = readFileSync(UDL);
    let text = buffer.toString("utf8");
    if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) text = buffer.toString("utf16le");
    const line = text.split(/\r?\n/).find((item) => /provider\s*=/i.test(item)) || "";
    const take = (name) => {
      const match = line.match(new RegExp(`${name}\\s*=\\s*([^;]*)`, "i"));
      return match ? match[1].trim() : "";
    };
    const integrated = /integrated security\s*=\s*(sspi|true|yes)/i.test(line);
    const user = take("user id");
    return {
      server: take("data source") || "(local)",
      database: take("initial catalog") || "VEGADB",
      user,
      password: take("password"),
      integrated: integrated || !user,
    };
  } catch {
    return { server: "(local)", database: "VEGADB", user: "", password: "", integrated: true };
  }
}

const link = readUdl();

function decodeSql(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(String(value ?? ""), "latin1");
  let text = "";
  for (const byte of buffer) {
    text += byte < 0x80 ? String.fromCharCode(byte) : String.fromCharCode(CP857[byte - 0x80]);
  }
  return text;
}

function parseJsonMetin(text) {
  text = String(text || "").replace(/^\uFEFF/, "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]+/g, "").trim();
  if (!text) return [];
  const slices = [text];
  const objectStart = text.indexOf("{");
  const objectEnd = text.lastIndexOf("}");
  if (objectStart >= 0 && objectEnd > objectStart) slices.push(text.slice(objectStart, objectEnd + 1));
  const arrayStart = text.indexOf("[");
  const arrayEnd = text.lastIndexOf("]");
  if (arrayStart >= 0 && arrayEnd > arrayStart) slices.push(text.slice(arrayStart, arrayEnd + 1));
  for (const slice of slices) {
    try {
      const parsed = JSON.parse(slice);
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      // sqlcmd başlık satırını ayıkla
    }
  }
  throw new Error("SQL sonucu okunamadı");
}

function parseJson(stdout) {
  return parseJsonMetin(decodeSql(stdout));
}

function sqlParcasi(value) {
  if (value == null) return "";
  if (Buffer.isBuffer(value) && value.length === 0) return "";
  return decodeSql(value).trim();
}

function sqlHata(error) {
  const detail = [sqlParcasi(error && error.stderr), sqlParcasi(error && error.stdout), sqlParcasi(error && error.message)]
    .filter(Boolean)
    .join(" ")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-4)
    .join(" ");
  return new Error(detail.slice(0, 400) || "SQL sorgusu çalışmadı");
}

function sqlKimlikleri() {
  const denemeler = [];
  if (link.user && !link.integrated) denemeler.push(["-U", link.user, "-P", link.password]);
  denemeler.push(["-E"]);
  return denemeler;
}

function sqlCalistir(sql, args) {
  const dosya = join(tmpdir(), `vega-${randomBytes(8).toString("hex")}.sql`);
  writeFileSync(dosya, Buffer.from(`\uFEFF${sql}`, "utf16le"));
  const calistir = (kimlik) => execFileAsync(
    SQLCMD,
    ["-S", link.server, "-d", link.database, ...kimlik, "-b", ...args, "-i", dosya],
    { windowsHide: true, encoding: "buffer", maxBuffer: 32 * 1024 * 1024 }
  );
  const denemeler = sqlKimlikleri();
  const sirayla = (index) => calistir(denemeler[index]).catch((error) => {
    if (index + 1 < denemeler.length) return sirayla(index + 1);
    throw error;
  });
  return sirayla(0).finally(() => {
    try { unlinkSync(dosya); } catch { /* geçici dosya silinemedi */ }
  });
}

function psSqlHazirla(sql, mod) {
  if (mod === "bayt") return { sql, sarmal: "bayt" };
  if (mod !== "json") return { sql, sarmal: "satir" };
  const tek = /FOR\s+JSON\s+PATH\s*,\s*WITHOUT_ARRAY_WRAPPER/i.test(sql);
  const temiz = sql.replace(/\s+FOR\s+JSON\s+PATH\s*(,\s*WITHOUT_ARRAY_WRAPPER)?\s*;?\s*$/i, "");
  return { sql: temiz, sarmal: tek ? "nesne" : "dizi" };
}

function psCalistir(sql, mod) {
  const hazir = psSqlHazirla(sql, mod);
  const id = randomBytes(8).toString("hex");
  const kok = join(tmpdir(), `vega-${id}`);
  const sqlDosya = `${kok}.sql`;
  const outDosya = `${kok}.out`;
  const errDosya = `${kok}.err`;
  const ps1 = `${kok}.ps1`;
  writeFileSync(sqlDosya, Buffer.from(`\uFEFF${hazir.sql}`, "utf16le"));
  const b64 = (value) => Buffer.from(String(value), "utf16le").toString("base64");
  const baglar = [];
  if (link.user && !link.integrated) {
    baglar.push(`Server=${link.server};Database=${link.database};User ID=${link.user};Password=${link.password};TrustServerCertificate=True`);
  }
  baglar.push(`Server=${link.server};Database=${link.database};Integrated Security=True;TrustServerCertificate=True`);
  const govde = [
    "$ErrorActionPreference = 'Stop'",
    "$sqlPath = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('" + b64(sqlDosya) + "'))",
    "$outPath = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('" + b64(outDosya) + "'))",
    "$errPath = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('" + b64(errDosya) + "'))",
    "$sarmal = '" + hazir.sarmal + "'",
    "$aday = @(" + baglar.map((cs) => "'" + b64(cs) + "'").join(",") + ")",
    "function HataYaz($err) {",
    "  $ex = $err.Exception",
    "  $mesajlar = New-Object System.Collections.Generic.List[string]",
    "  while ($ex) {",
    "    if ($ex.Errors) { foreach ($e in $ex.Errors) { if ($e.Message) { $mesajlar.Add($e.Message) } } }",
    "    elseif ($ex.Message) { $mesajlar.Add($ex.Message) }",
    "    $ex = $ex.InnerException",
    "  }",
    "  if ($mesajlar.Count -eq 0) { $mesajlar.Add([string]$err) }",
    "  [IO.File]::WriteAllText($errPath, (($mesajlar | Select-Object -Unique) -join ' '), (New-Object System.Text.UTF8Encoding $false))",
    "}",
    "function Yazi($v) {",
    "  if ($null -eq $v -or $v -is [DBNull]) { return '' }",
    "  if ($v -is [string]) { return $v }",
    "  if ($v -is [IFormattable]) { return $v.ToString([Globalization.CultureInfo]::InvariantCulture) }",
    "  return [string]$v",
    "}",
    "try {",
    "  Add-Type -AssemblyName System.Data",
    "  $conn = $null",
    "  $sonHata = $null",
    "  foreach ($b64 in $aday) {",
    "    $cs = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($b64))",
    "    $deneme = New-Object System.Data.SqlClient.SqlConnection $cs",
    "    try {",
    "      $deneme.Open()",
    "      $conn = $deneme",
    "      break",
    "    } catch {",
    "      $sonHata = $_",
    "      $deneme.Dispose()",
    "    }",
    "  }",
    "  if (-not $conn) { throw $sonHata }",
    "  try {",
    "    $cmd = $conn.CreateCommand()",
    "    $cmd.CommandTimeout = 180",
    "    $cmd.CommandText = [IO.File]::ReadAllText($sqlPath, [Text.Encoding]::Unicode).TrimStart([char]0xFEFF)",
    "    $reader = $cmd.ExecuteReader()",
    "    $satirlar = New-Object System.Collections.Generic.List[object]",
    "    $sb = New-Object System.Text.StringBuilder",
    "    if ($reader.FieldCount -gt 0) {",
    "      while ($reader.Read()) {",
    "        if ($sarmal -eq 'bayt') {",
    "          if (-not $reader.IsDBNull(0)) {",
    "            $ham = $reader.GetValue(0)",
    "            if ($ham -is [byte[]]) { [void]$sb.Append([Convert]::ToBase64String($ham)) }",
    "          }",
    "          break",
    "        }",
    "        if ($sarmal -eq 'satir') {",
    "          $parca = New-Object System.Collections.Generic.List[string]",
    "          for ($i = 0; $i -lt $reader.FieldCount; $i++) {",
    "            if ($reader.IsDBNull($i)) { $parca.Add('') } else { $parca.Add((Yazi $reader.GetValue($i))) }",
    "          }",
    "          [void]$sb.AppendLine(($parca -join '|'))",
    "        } else {",
    "          $row = [ordered]@{}",
    "          for ($i = 0; $i -lt $reader.FieldCount; $i++) {",
    "            $ad = $reader.GetName($i)",
    "            if (-not $ad -or $reader.IsDBNull($i)) { continue }",
    "            $val = $reader.GetValue($i)",
    "            $sayi = $val -is [byte] -or $val -is [int16] -or $val -is [int] -or $val -is [long] -or $val -is [decimal] -or $val -is [double] -or $val -is [single] -or $val -is [uint16] -or $val -is [uint32] -or $val -is [uint64]",
    "            if ($val -is [string] -or $val -is [bool] -or $sayi) {",
    "              $row[$ad] = $val",
    "            } else { $row[$ad] = (Yazi $val) }",
    "          }",
    "          $satirlar.Add($row)",
    "        }",
    "      }",
    "    }",
    "    $reader.Close()",
    "    if ($sarmal -eq 'satir' -or $sarmal -eq 'bayt') {",
    "      $cikti = $sb.ToString()",
    "    } elseif ($sarmal -eq 'nesne') {",
    "      if ($satirlar.Count -eq 0) { $cikti = '' }",
    "      else { $cikti = ConvertTo-Json -InputObject $satirlar[0] -Compress -Depth 4 }",
    "    } elseif ($satirlar.Count -eq 0) {",
    "      $cikti = '[]'",
    "    } else {",
    "      $cikti = ConvertTo-Json -InputObject $satirlar.ToArray() -Compress -Depth 4",
    "    }",
    "    [IO.File]::WriteAllText($outPath, $cikti, (New-Object System.Text.UTF8Encoding $false))",
    "  } finally { $conn.Close() }",
    "} catch {",
    "  HataYaz $_",
    "  exit 1",
    "}",
  ].join("\r\n");
  writeFileSync(ps1, Buffer.from(`\uFEFF${govde}`, "utf16le"));
  const sil = () => {
    for (const dosya of [sqlDosya, outDosya, errDosya, ps1]) {
      try { unlinkSync(dosya); } catch { /* geçici dosya silinemedi */ }
    }
  };
  return execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1],
    { windowsHide: true, encoding: "buffer", maxBuffer: 8 * 1024 * 1024 }
  ).then(() => readFileSync(outDosya)).catch((error) => {
    let mesaj = "";
    try { mesaj = readFileSync(errDosya, "utf8").replace(/^\uFEFF/, "").trim(); } catch { /* hata dosyası yok */ }
    if (mesaj) throw new Error(mesaj.slice(0, 400));
    throw error;
  }).finally(sil);
}

function sorguMetni(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(String(buffer ?? ""), "utf8");
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.toString("utf16le");
  return buf.toString("utf8");
}

function sorguHatasi(error) {
  if (error && !error.stderr && !error.stdout && error.message) throw error;
  throw sqlHata(error);
}

function query(sql) {
  return psCalistir(sql, "json").then((stdout) => parseJsonMetin(sorguMetni(stdout)), sorguHatasi);
}

function queryBytes(sql) {
  return psCalistir(sql, "bayt").then((stdout) => {
    const text = sorguMetni(stdout).replace(/\s+/g, "");
    if (!text) return null;
    const buf = Buffer.from(text, "base64");
    return buf.length ? buf : null;
  }, sorguHatasi);
}

function queryLines(sql) {
  const ayikla = (text) => text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("(") && line.includes("|"));
  const ps = () => psCalistir(sql, "lines").then((stdout) => ayikla(sorguMetni(stdout)), sorguHatasi);
  if (!SQLCMD) return ps();
  return sqlCalistir(sql, ["-h", "-1", "-s", "|", "-w", "65535", "-y", "400", "-Y", "400"]).then(({ stdout }) => {
    return ayikla(decodeSql(stdout));
  }).catch(() => ps());
}

const semaOnbellek = new Map();

async function nesneVar(ad) {
  const adlar = (Array.isArray(ad) ? ad : [ad]).map((item) => String(item).replace(/[^\w]/g, "")).filter(Boolean);
  if (!adlar.length) return "";
  const anahtar = "n:" + adlar.map((item) => item.toUpperCase()).sort().join(",");
  if (semaOnbellek.has(anahtar)) return semaOnbellek.get(anahtar);
  const liste = adlar.map((item) => `N'${item}'`).join(", ");
  const lines = await queryLines(`
SET NOCOUNT ON;
SELECT N'v', TABLE_NAME
FROM INFORMATION_SCHEMA.TABLES
WHERE TABLE_NAME IN (${liste});
`);
  const bulunan = new Set(lines.map((line) => (line.split("|")[1] || "").trim().toUpperCase()));
  const sonuc = adlar.find((item) => bulunan.has(item.toUpperCase())) || "";
  semaOnbellek.set(anahtar, sonuc);
  return sonuc;
}

async function kolonKumesi(tablo) {
  const ad = String(tablo).replace(/[^\w]/g, "");
  if (!ad) return new Set();
  const anahtar = "k:" + ad.toUpperCase();
  if (semaOnbellek.has(anahtar)) return semaOnbellek.get(anahtar);
  const lines = await queryLines(`
SET NOCOUNT ON;
SELECT N'v', COLUMN_NAME
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_NAME = N'${ad}';
`);
  const sonuc = new Set(lines.map((line) => (line.split("|")[1] || "").trim().toUpperCase()));
  semaOnbellek.set(anahtar, sonuc);
  return sonuc;
}

function notIfadesi(kolonlar, takma, adaylar) {
  const ad = adaylar.find((item) => kolonlar.has(item));
  if (!ad) return "N''";
  const alan = `CAST(${takma}.${ad} AS nvarchar(400))`;
  return `LTRIM(RTRIM(REPLACE(REPLACE(REPLACE(
    CASE
      WHEN CHARINDEX(CHAR(13), ISNULL(${alan}, N'')) > 1 THEN LEFT(${alan}, CHARINDEX(CHAR(13), ${alan}) - 1)
      WHEN CHARINDEX(CHAR(10), ISNULL(${alan}, N'')) > 1 THEN LEFT(${alan}, CHARINDEX(CHAR(10), ${alan}) - 1)
      ELSE ISNULL(${alan}, N'')
    END, N'|', N'/'), CHAR(13), N' '), CHAR(10), N' ')))`;
}

function duzYazi(kolonlar, takma, adaylar) {
  const ad = adaylar.find((item) => kolonlar.has(item));
  if (!ad) return "N''";
  return `REPLACE(REPLACE(REPLACE(RTRIM(ISNULL(${takma}.${ad}, N'')), N'|', N'/'), CHAR(13), N' '), CHAR(10), N' ')`;
}

function tamSayi(value, max = 9999) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > max) return null;
  return n;
}

function tarihParca(value) {
  const parca = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(String(value || "").trim());
  if (!parca) return null;
  return { gun: Number(parca[1]), ay: Number(parca[2]), yil: Number(parca[3]) };
}

async function satisHareketKaynaklari(firma, donem, basHam, bitHam, yillarHam, firmalarHam) {
  const basP = tarihParca(basHam);
  const bitP = tarihParca(bitHam);
  const istenen = String(yillarHam || "")
    .split(",")
    .map((parca) => Number(parca.trim()))
    .filter((yil) => yil >= 1990 && yil <= 2100);
  const firmalar = String(firmalarHam || "")
    .split(",")
    .map((parca) => Number(parca.trim()))
    .filter((no) => Number.isInteger(no) && no >= 1 && no <= 9999);
  if (!firmalar.includes(Number(firma))) firmalar.unshift(Number(firma));
  const liste = [];
  const gorulen = new Set();
  for (const firmaNo of firmalar) {
    const donemler = await donemleriGetir(firmaNo);
    const aday = donemler.filter((item) => {
      const yil = Number(item.yil) || 0;
      if (!yil) return false;
      if (istenen.length) return istenen.includes(yil);
      if (basP && bitP) return yil >= basP.yil && yil <= bitP.yil;
      return yil === (basP?.yil || bitP?.yil);
    });
    for (const item of aday) {
      const tablo = donemTablo(firmaNo, item.no, "TBLSTOKHAREKETLERI");
      if (gorulen.has(tablo) || !(await nesneVar(tablo))) continue;
      gorulen.add(tablo);
      liste.push({
        yil: Number(item.yil),
        donem: item.no,
        firma: firmaNo,
        tablo,
        stok: firmaTablo(firmaNo, "TBLSTOKLAR"),
        cari: firmaTablo(firmaNo, "TBLCARI"),
      });
    }
  }
  if (!liste.length && firma && donem) {
    liste.push({
      yil: basP?.yil || 0,
      donem,
      firma,
      tablo: donemTablo(firma, donem, "TBLSTOKHAREKETLERI"),
      stok: firmaTablo(firma, "TBLSTOKLAR"),
      cari: firmaTablo(firma, "TBLCARI"),
    });
  }
  liste.sort((a, b) => a.yil - b.yil || a.firma - b.firma);
  return liste;
}

async function satisSorguBirlestir(kaynaklar, sorgu) {
  const lines = [];
  let hata = null;
  for (const kaynak of kaynaklar) {
    try {
      const parca = await queryLines(sorgu(kaynak));
      for (const line of parca) lines.push(line);
    } catch (error) {
      hata = error;
    }
  }
  if (!lines.length && hata) throw hata;
  return lines;
}

function satisAnalizEtiket(kolon, anahtar) {
  const yazi = String(anahtar || "");
  if (kolon === "ay" && /^\d{4}-\d{2}$/.test(yazi)) {
    const aylar = ["Ocak", "Şubat", "Mart", "Nisan", "Mayıs", "Haziran", "Temmuz", "Ağustos", "Eylül", "Ekim", "Kasım", "Aralık"];
    return (aylar[Number(yazi.slice(5)) - 1] || yazi.slice(5)) + " " + yazi.slice(0, 4);
  }
  if (kolon === "hafta") return yazi.replace(/^(\d{4})-H/, "H");
  if (/^\d{4}-\d{2}-\d{2}$/.test(yazi)) return yazi.slice(8) + "." + yazi.slice(5, 7);
  return yazi;
}

function sqlTarihIfade(value) {
  const yazi = String(value || "").trim();
  if (!/^\d{2}\.\d{2}\.\d{4}$/.test(yazi)) return "";
  return `CONVERT(datetime, N'${yazi}', 104)`;
}

function sqlOndalik(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "0";
  return (Math.round(n * 10000) / 10000).toFixed(4);
}

function portNo(value) {
  const n = Number(String(value ?? "").replace(/[^\d]/g, ""));
  if (!Number.isFinite(n) || n <= 0) return 0;
  const ham = n >= 100000000 ? n - 100000000 : n;
  return ham > 2147483647 ? 0 : ham;
}

function metin(value, max) {
  return String(value ?? "").replace(/'/g, "''").slice(0, max);
}

function ara(value) {
  return String(value ?? "").replace(/[%_\[\];']/g, "").replace(/\s+/g, " ").trim().slice(0, 80);
}

function pad(n) {
  return String(n).padStart(4, "0");
}

function firmaTablo(firma, ad) {
  return `F${pad(firma)}${ad}`;
}

async function cariHareketTablolari(firma) {
  const onek = `F${pad(firma)}D`;
  const lines = await queryLines(`
SET NOCOUNT ON;
SELECT N'v', TABLE_NAME
FROM INFORMATION_SCHEMA.TABLES
WHERE TABLE_NAME LIKE N'${onek}%TBLCARIHAREKETLERI';
`);
  return lines
    .map((line) => (line.split("|")[1] || "").trim())
    .filter((ad) => new RegExp(`^F${pad(firma)}D\\d+TBLCARIHAREKETLERI$`, "i").test(ad));
}

function donemTablo(firma, donem, ad) {
  return `F${pad(firma)}D${pad(donem)}${ad}`;
}

function sqlKolon(kolonlar, adaylar, yedek = "N''") {
  const ad = adaylar.find((item) => kolonlar.has(String(item).toUpperCase()));
  if (!ad) return yedek;
  return `REPLACE(REPLACE(REPLACE(RTRIM(ISNULL(CAST(${ad} AS nvarchar(200)), N'')), N'|', N'/'), CHAR(13), N' '), CHAR(10), N' ')`;
}

function firmaMetinBirlestir(parcalar) {
  const tekil = [];
  for (const parca of parcalar) {
    const yazi = String(parca || "").trim();
    if (!yazi) continue;
    if (tekil.some((item) => item.toLocaleUpperCase("tr") === yazi.toLocaleUpperCase("tr"))) continue;
    tekil.push(yazi);
  }
  return tekil.join(" ");
}

async function vegaTabloHaritasi() {
  const anahtar = "vega-tablolar";
  if (semaOnbellek.has(anahtar)) return semaOnbellek.get(anahtar);
  const lines = await queryLines(`
SET NOCOUNT ON;
SELECT N't', TABLE_NAME
FROM INFORMATION_SCHEMA.TABLES
WHERE TABLE_NAME LIKE N'F[0-9][0-9][0-9][0-9]%';
`);
  const firmalar = new Map();
  for (const line of lines) {
    const ad = (line.split("|")[1] || "").trim().toUpperCase();
    const eslesme = ad.match(/^F(\d{4})(?:D(\d{4}))?(TBL.+)$/);
    if (!eslesme) continue;
    const no = Number(eslesme[1]);
    if (!no) continue;
    if (!firmalar.has(no)) firmalar.set(no, { donemler: new Set(), tablolar: new Set() });
    const kayit = firmalar.get(no);
    kayit.tablolar.add(eslesme[3]);
    if (eslesme[2]) kayit.donemler.add(Number(eslesme[2]));
  }
  semaOnbellek.set(anahtar, firmalar);
  return firmalar;
}

async function firmalariGetir() {
  const kayitlar = [];
  try {
    if (await nesneVar("TBLFIRMA")) {
      const kolonlar = await kolonKumesi("TBLFIRMA");
      if (kolonlar.has("IND")) {
        const lines = await queryLines(`
SET NOCOUNT ON;
SELECT N'f',
  CAST(IND AS varchar(12)),
  ${sqlKolon(kolonlar, ["KOD", "FIRMAKODU"])},
  ${sqlKolon(kolonlar, ["KISAAD", "KISAADI", "FIRMAADI", "UNVAN"])},
  ${sqlKolon(kolonlar, ["AD1", "AD", "FIRMAADI", "UNVAN"])},
  ${kolonlar.has("AKTIFDONEM") ? "CAST(ISNULL(AKTIFDONEM, 0) AS varchar(12))" : "N'0'"},
  ${sqlKolon(kolonlar, ["TELEFON1", "TELEFON", "TEL1", "TEL"])},
  ${sqlKolon(kolonlar, ["TELEFON2", "TEL2", "GSM", "CEPTEL", "CEP"])},
  ${sqlKolon(kolonlar, ["MAHALLE"])},
  ${sqlKolon(kolonlar, ["CADDE"])},
  ${sqlKolon(kolonlar, ["SOKAK"])},
  ${sqlKolon(kolonlar, ["APARTMANADI"])},
  ${sqlKolon(kolonlar, ["APARTMANNO"])},
  ${sqlKolon(kolonlar, ["DAIRE"])},
  ${sqlKolon(kolonlar, ["POSTAKODU"])},
  ${sqlKolon(kolonlar, ["ILCE"])},
  ${sqlKolon(kolonlar, ["SEHIR", "IL"])},
  ${sqlKolon(kolonlar, ["MAIL", "EMAIL", "EPOSTA"])},
  ${sqlKolon(kolonlar, ["WEBSITE", "WEB"])}
FROM TBLFIRMA
ORDER BY IND;
`);
        for (const line of lines) {
          const p = line.split("|");
          if ((p[0] || "").trim() !== "f") continue;
          const no = Number((p[1] || "").trim()) || 0;
          if (!no) continue;
          const parca = (index) => (p[index] || "").trim();
          const kapi = parca(12);
          const daire = parca(13);
          kayitlar.push({
            no,
            kod: parca(2),
            kisaAd: parca(3),
            ad: parca(4),
            aktifDonem: Number(parca(5)) || 0,
            telefon: firmaMetinBirlestir([parca(6), parca(7)]),
            adres: firmaMetinBirlestir([
              parca(8), parca(9), parca(10), parca(11),
              kapi && /^\d/.test(kapi) ? "No: " + kapi : kapi,
              daire && !/^daire\b/i.test(daire) ? "Daire: " + daire : daire,
              parca(14), parca(15), parca(16),
            ]),
            eposta: parca(17),
            web: parca(18),
          });
        }
      }
    }
  } catch { /* firma tablosu klasik düzende değil */ }
  if (kayitlar.length) return kayitlar;
  const harita = await vegaTabloHaritasi();
  return [...harita.entries()]
    .filter(([, kayit]) => ["TBLCARI", "TBLSTOKLAR", "TBLSUBELER", "TBLCARIHAREKETLERI"].some((ad) => (
      kayit.tablolar.has(ad) || [...kayit.tablolar].some((tablo) => tablo.endsWith(ad))
    )))
    .map(([no]) => ({ no, kod: String(no), kisaAd: "Firma " + no, ad: "Firma " + no, aktifDonem: 0 }))
    .sort((a, b) => a.no - b.no);
}

async function donemleriGetir(firmaNo) {
  const liste = [];
  try {
    if (await nesneVar("TBLDONEM")) {
      const kolonlar = await kolonKumesi("TBLDONEM");
      const noKolon = ["IND", "DONEMNO"].find((ad) => kolonlar.has(ad));
      const yilKolon = ["DONEM", "YIL"].find((ad) => kolonlar.has(ad));
      const firmaKolon = ["FIND", "FIRMANO", "FIRMA"].find((ad) => kolonlar.has(ad));
      if (noKolon && yilKolon) {
        const where = firmaKolon ? `WHERE ${firmaKolon} = ${Number(firmaNo) || 0}` : "";
        const lines = await queryLines(`
SET NOCOUNT ON;
SELECT N'd', CAST(${noKolon} AS varchar(12)), CAST(${yilKolon} AS varchar(12))
FROM TBLDONEM
${where}
ORDER BY ${yilKolon}, ${noKolon};
`);
        for (const line of lines) {
          const p = line.split("|");
          if ((p[0] || "").trim() !== "d") continue;
          const no = Number((p[1] || "").trim()) || 0;
          const yil = Number((p[2] || "").trim()) || 0;
          if (no) liste.push({ no, yil: yil || no });
        }
      }
    }
  } catch { /* dönem tablosu okunamadı */ }
  if (liste.length) return liste;
  const harita = await vegaTabloHaritasi();
  const donemler = harita.get(Number(firmaNo))?.donemler || new Set();
  return [...donemler].filter(Boolean).sort((a, b) => a - b).map((no) => ({ no, yil: no }));
}

async function subeleriGetir(firmaNo) {
  const adaylar = [
    firmaTablo(firmaNo, "TBLSUBELER"),
    firmaTablo(firmaNo, "TBLSUBE"),
    "TBLSUBELER",
  ];
  for (const ad of adaylar) {
    try {
      const tablo = await nesneVar(ad);
      if (!tablo) continue;
      const kolonlar = await kolonKumesi(tablo);
      if (!kolonlar.has("IND")) continue;
      const adIfade = sqlKolon(kolonlar, ["SUBEAD", "SUBEADI", "AD", "ADI", "ACIKLAMA"], "N'MERKEZ'");
      const lines = await queryLines(`
SET NOCOUNT ON;
SELECT N's', CAST(IND AS varchar(12)), ${adIfade}
FROM ${tablo}
ORDER BY IND;
`);
      const temiz = [];
      for (const line of lines) {
        const p = line.split("|");
        if ((p[0] || "").trim() !== "s") continue;
        temiz.push({ no: Number((p[1] || "").trim()) || 0, ad: (p[2] || "").trim() || "MERKEZ" });
      }
      if (temiz.length) return temiz;
    } catch { /* bu şube tablosu yok */ }
  }
  return [{ no: 1, ad: "MERKEZ" }];
}

const oturumlar = new Map();
const girisOnbilgiOnbellek = new Map();

async function girisOnbilgiGetir(tercihFirma) {
  const anahtar = String(tercihFirma || 0);
  const onceki = girisOnbilgiOnbellek.get(anahtar);
  if (onceki && Date.now() - onceki.zaman < 120000) return onceki.veri;
  const tercih = tercihFirma || 101;
  const kullaniciKolon = await kolonKumesi("TBLUSERS").catch(() => new Set());
  const kullaniciAlan = (adaylar, yedek) => (kullaniciKolon.size ? sqlKolon(kullaniciKolon, adaylar, yedek) : yedek);
  const lines = await queryLines(`
SET NOCOUNT ON;
SELECT N'u',
  ${kullaniciAlan(["USERNAME"], "N''")},
  ${kullaniciAlan(["AD"], "N''")},
  ${kullaniciAlan(["SOYAD"], "N''")},
  ${kullaniciKolon.has("FIRMA") ? "CAST(ISNULL(FIRMA, 0) AS varchar(12))" : "N'0'"},
  ${kullaniciKolon.has("DONEM") ? "CAST(ISNULL(DONEM, 0) AS varchar(12))" : "N'0'"},
  ${kullaniciKolon.has("SIFRE") ? "CASE WHEN NULLIF(LTRIM(RTRIM(ISNULL(SIFRE, N''))), N'') IS NULL THEN N'0' ELSE N'1' END" : "N'0'"}
FROM TBLUSERS
${kullaniciKolon.has("USERNAME") ? "WHERE ISNULL(USERNAME, N'') <> N''" : ""}
ORDER BY ${kullaniciKolon.has("USERNAME") ? "USERNAME" : "IND"};
`);
  const kullanicilar = [];
  for (const line of lines) {
    const p = line.split("|");
    if ((p[0] || "").trim() !== "u") continue;
    kullanicilar.push({
      kullanici: (p[1] || "").trim(),
      ad: (p[2] || "").trim(),
      soyad: (p[3] || "").trim(),
      firma: Number(p[4]) || 0,
      donem: Number(p[5]) || 0,
      sifreVar: (p[6] || "").trim() === "1" ? 1 : 0,
    });
  }
  const firmalar = await firmalariGetir();
  let firmaNo = tercihFirma || tercih;
  if (!firmalar.some((item) => item.no === firmaNo)) {
    firmaNo = firmalar.find((item) => item.no === 101)?.no || firmalar[0]?.no || firmaNo;
  }
  const [donemler, subeler] = await Promise.all([
    donemleriGetir(firmaNo),
    subeleriGetir(firmaNo),
  ]);
  const veri = {
    surum: UYGULAMA_SURUM,
    server: link.server,
    database: link.database,
    kullanicilar,
    firmalar,
    firma: firmaNo,
    donemler,
    subeler,
  };
  girisOnbilgiOnbellek.set(anahtar, { zaman: Date.now(), veri });
  if (anahtar !== "0" && !tercihFirma) girisOnbilgiOnbellek.set("0", { zaman: Date.now(), veri });
  return veri;
}

function okuGovde(req) {
  return new Promise((resolve, reject) => {
    const parca = [];
    req.on("data", (buf) => parca.push(buf));
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

function gonder(res, status, body) {
  const raw = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(raw);
}

function oturum(req) {
  const header = String(req.headers.authorization || "");
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  return token && oturumlar.get(token);
}

function sayfaOku() {
  const { getAsset, isSea } = require("node:sea");
  if (isSea()) return Buffer.from(getAsset("index.html"));
  const yaninda = join(dirname(process.execPath), "index.html");
  if (existsSync(yaninda)) return readFileSync(yaninda);
  return readFileSync(join(__dirname, "index.html"));
}

function uygulamaKok() {
  try {
    if (require("node:sea").isSea()) return dirname(process.execPath);
  } catch { /* geliştirme */ }
  return __dirname;
}

function whatsappKlasor() {
  return join(uygulamaKok(), "whatsapp-oturum");
}

function hatirlatmaKok() {
  const local = process.env.LOCALAPPDATA || uygulamaKok();
  const yol = join(local, "Vega Raporlama", "hatirlatmalar");
  if (!existsSync(yol)) mkdirSync(yol, { recursive: true });
  return yol;
}

function hatirlatmaDosya() {
  return join(hatirlatmaKok(), "hatirlatmalar.json");
}

function hatirlatmaGosterVbs() {
  const yol = join(hatirlatmaKok(), "goster.vbs");
  const govde = [
    "If WScript.Arguments.Count < 1 Then WScript.Quit 1",
    "Dim id, fso, kok, ps1, cmd, sh",
    "id = WScript.Arguments(0)",
    "Set fso = CreateObject(\"Scripting.FileSystemObject\")",
    "kok = fso.GetParentFolderName(WScript.ScriptFullName)",
    "ps1 = kok & \"\\goster.ps1\"",
    "cmd = \"powershell.exe -STA -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"\"\" & ps1 & \"\"\" -Id \"\"\" & id & \"\"\"\"",
    "Set sh = CreateObject(\"WScript.Shell\")",
    "sh.Run cmd, 0, True",
  ].join("\r\n");
  writeFileSync(yol, govde, "utf8");
  return yol;
}

function hatirlatmaGorevArg(vbs, id) {
  return `//B "${vbs}" "${id}"`;
}

function hatirlatmaGosterPs1() {
  hatirlatmaGosterVbs();
  const yol = join(hatirlatmaKok(), "goster.ps1");
  const govde = [
    "param([Parameter(Mandatory=$true)][string]$Id)",
    "$ErrorActionPreference = 'Continue'",
    "try {",
    "  Add-Type -Name Z -Namespace H -MemberDefinition '[DllImport(\"user32.dll\")]public static extern bool ShowWindow(IntPtr h,int c);[DllImport(\"kernel32.dll\")]public static extern IntPtr GetConsoleWindow();' -ErrorAction Stop",
    "  $cw = [H.Z]::GetConsoleWindow(); if ($cw -ne [IntPtr]::Zero) { [void][H.Z]::ShowWindow($cw, 0) }",
    "} catch {}",
    "$kok = Split-Path -Parent $MyInvocation.MyCommand.Path",
    "$dosya = Join-Path $kok 'hatirlatmalar.json'",
    "$log = Join-Path $kok 'goster.log'",
    "function Yaz-Log([string]$m) { try { Add-Content -LiteralPath $log -Value ((Get-Date).ToString('s') + ' ' + $m) -Encoding UTF8 } catch {} }",
    "Yaz-Log ('basla id=' + $Id + ' sta=' + [Threading.Thread]::CurrentThread.GetApartmentState())",
    "if (-not (Test-Path $dosya)) { Yaz-Log 'json yok'; exit 0 }",
    "$raw = [IO.File]::ReadAllText($dosya, [Text.Encoding]::UTF8)",
    "$parsed = ConvertFrom-Json -InputObject $raw",
    "$liste = New-Object System.Collections.ArrayList",
    "if ($null -ne $parsed) {",
    "  if ($parsed -is [System.Collections.IEnumerable] -and $parsed -isnot [string] -and $parsed -isnot [System.Collections.IDictionary]) {",
    "    foreach ($x in $parsed) { if ($null -ne $x) { [void]$liste.Add($x) } }",
    "  } else { [void]$liste.Add($parsed) }",
    "}",
    "Yaz-Log ('json adet=' + $liste.Count)",
    "$item = $null",
    "foreach ($x in $liste) { if ([string]$x.id -eq $Id) { $item = $x; break } }",
    "if (-not $item) { Yaz-Log ('kayit yok id=' + $Id); exit 0 }",
    "$metin = [string]$item.metin",
    "if ($metin -match 'do[gğ]um\\s*g[uü]n[uü]|birthday') {",
    "  Unregister-ScheduledTask -TaskName ('VegaRaporlama\\H-' + $Id) -Confirm:$false -ErrorAction SilentlyContinue",
    "  Yaz-Log 'dogum gunu atlandi'",
    "  exit 0",
    "}",
    "$gunYazi = [string]$item.gun",
    "$saatYazi = [string]$item.saat",
    "if ($gunYazi -match '^(\\d{4})-(\\d{2})-(\\d{2})$') { $gunGoster = $Matches[3] + '.' + $Matches[2] + '.' + $Matches[1] } else { $gunGoster = $gunYazi }",
    "$baslik = [string]::Concat('Vega ', [char]0x0048, [char]0x0061, [char]0x0074, [char]0x0131, [char]0x0072, [char]0x006C, [char]0x0061, [char]0x0074, [char]0x006D, [char]0x0061)",
    "if ($gunGoster) { $baslik = $baslik + ' - ' + $gunGoster + ' ' + $saatYazi }",
    "Add-Type -AssemblyName System.Windows.Forms | Out-Null",
    "Add-Type -AssemblyName System.Drawing | Out-Null",
    "[Windows.Forms.Application]::EnableVisualStyles()",
    "function Kaydet-Liste($rows) {",
    "  $arr = @($rows)",
    "  if ($arr.Count -eq 0) { $json = '[]' }",
    "  elseif ($arr.Count -eq 1) { $json = '[' + (ConvertTo-Json -InputObject $arr[0] -Depth 6 -Compress) + ']' }",
    "  else { $json = ConvertTo-Json -InputObject $arr -Depth 6 -Compress }",
    "  $utf8 = New-Object System.Text.UTF8Encoding $false",
    "  [IO.File]::WriteAllText($dosya, $json, $utf8)",
    "}",
    "function Gorev-Kur([string]$hid, [datetime]$zaman) {",
    "  $ad = 'VegaRaporlama\\H-' + $hid",
    "  Unregister-ScheduledTask -TaskName $ad -Confirm:$false -ErrorAction SilentlyContinue",
    "  if ($zaman -le (Get-Date).AddSeconds(-30)) { return }",
    "  $vbs = Join-Path $kok 'goster.vbs'",
    "  $arg = '//B \"' + $vbs + '\" \"' + $hid + '\"'",
    "  $action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument $arg",
    "  $trigger = New-ScheduledTaskTrigger -Once -At $zaman",
    "  $trigger.EndBoundary = $zaman.AddHours(12).ToString('s')",
    "  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 1)",
    "  $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited",
    "  Register-ScheduledTask -TaskName $ad -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null",
    "}",
    "$form = New-Object System.Windows.Forms.Form",
    "$form.Text = $baslik",
    "$form.Width = 500",
    "$form.Height = 340",
    "$form.StartPosition = 'Manual'",
    "$form.TopMost = $true",
    "$form.ShowInTaskbar = $true",
    "$form.FormBorderStyle = 'FixedDialog'",
    "$form.MaximizeBox = $false",
    "$form.MinimizeBox = $false",
    "$form.BackColor = [Drawing.Color]::FromArgb(231, 238, 243)",
    "$form.Font = New-Object System.Drawing.Font('Segoe UI', 10)",
    "function Yerles-Form() {",
    "  $wa = [Windows.Forms.Screen]::FromPoint([Windows.Forms.Cursor]::Position).WorkingArea",
    "  if ($null -eq $wa) { $wa = [Windows.Forms.Screen]::PrimaryScreen.WorkingArea }",
    "  $form.Left = [Math]::Max($wa.Left, $wa.Left + [int](($wa.Width - $form.Width) / 2))",
    "  $form.Top = [Math]::Max($wa.Top, $wa.Top + [int](($wa.Height - $form.Height) / 2))",
    "}",
    "Yerles-Form",
    "$ust = New-Object System.Windows.Forms.Panel",
    "$ust.Left = 0; $ust.Top = 0; $ust.Width = 500; $ust.Height = 58",
    "$ust.BackColor = [Drawing.Color]::FromArgb(21, 113, 124)",
    "$form.Controls.Add($ust)",
    "$ustBas = New-Object System.Windows.Forms.Label",
    "$ustBas.Left = 16; $ustBas.Top = 8; $ustBas.Width = 460; $ustBas.Height = 22",
    "$ustBas.ForeColor = [Drawing.Color]::White",
    "$ustBas.Font = New-Object System.Drawing.Font('Segoe UI', 11, [Drawing.FontStyle]::Bold)",
    "$ustBas.Text = $baslik",
    "$ust.Controls.Add($ustBas)",
    "$ustAlt = New-Object System.Windows.Forms.Label",
    "$ustAlt.Left = 16; $ustAlt.Top = 30; $ustAlt.Width = 460; $ustAlt.Height = 20",
    "$ustAlt.ForeColor = [Drawing.Color]::FromArgb(220, 245, 248)",
    "$ustAlt.Text = $gunGoster + '  ' + $saatYazi",
    "$ust.Controls.Add($ustAlt)",
    "$kart = New-Object System.Windows.Forms.Panel",
    "$kart.Left = 16; $kart.Top = 70; $kart.Width = 450; $kart.Height = 100",
    "$kart.BackColor = [Drawing.Color]::White",
    "$form.Controls.Add($kart)",
    "$lbl = New-Object System.Windows.Forms.Label",
    "$lbl.Left = 12; $lbl.Top = 12; $lbl.Width = 420; $lbl.Height = 76",
    "$lbl.Text = $metin",
    "$kart.Controls.Add($lbl)",
    "$script:sonuc = 'tamam'",
    "$erteleLbl = New-Object System.Windows.Forms.Label",
    "$erteleLbl.Left = 16; $erteleLbl.Top = 182; $erteleLbl.Width = 300; $erteleLbl.Height = 20",
    "$erteleLbl.Font = New-Object System.Drawing.Font('Segoe UI', 10, [Drawing.FontStyle]::Bold)",
    "$erteleLbl.Text = [string]::Concat([char]0x0045, [char]0x0072, [char]0x0074, [char]0x0065, [char]0x006C, [char]0x0065, ':')",
    "$form.Controls.Add($erteleLbl)",
    "$butonlar = @(",
    "  @{ Text='15 dk'; X=16; Kod='15' },",
    "  @{ Text='1 saat'; X=128; Kod='60' },",
    "  @{ Text='3 saat'; X=240; Kod='180' },",
    "  @{ Text=([string]::Concat([char]0x0059,[char]0x0061,[char]0x0072,[char]0x0131,[char]0x006E)); X=352; Kod='yarin' }",
    ")",
    "foreach ($bilgi in $butonlar) {",
    "  $b = New-Object System.Windows.Forms.Button",
    "  $b.Text = $bilgi.Text",
    "  $b.Width = 100; $b.Height = 28; $b.Left = $bilgi.X; $b.Top = 210",
    "  $b.Tag = $bilgi.Kod",
    "  $b.Font = New-Object System.Drawing.Font('Segoe UI', 9)",
    "  $b.FlatStyle = 'System'",
    "  $b.Add_Click({ $script:sonuc = [string]$this.Tag; $form.Close() })",
    "  $form.Controls.Add($b)",
    "}",
    "$ok = New-Object System.Windows.Forms.Button",
    "$ok.Text = 'Tamam'",
    "$ok.Width = 100; $ok.Height = 28; $ok.Left = 352; $ok.Top = 250",
    "$ok.Font = New-Object System.Drawing.Font('Segoe UI', 9)",
    "$ok.Add_Click({ $script:sonuc = 'tamam'; $form.Close() })",
    "$form.AcceptButton = $ok",
    "$form.Controls.Add($ok)",
    "$form.Add_Shown({",
    "  Yerles-Form",
    "  $form.TopMost = $true",
    "  $form.Activate()",
    "  $form.BringToFront()",
    "  try {",
    "    Add-Type -Name FG -Namespace W -MemberDefinition '[DllImport(\"user32.dll\")]public static extern bool SetForegroundWindow(IntPtr hWnd);[DllImport(\"user32.dll\")]public static extern bool ShowWindow(IntPtr hWnd,int nCmdShow);' -ErrorAction SilentlyContinue",
    "    [void][W.FG]::ShowWindow($form.Handle, 5)",
    "    [void][W.FG]::SetForegroundWindow($form.Handle)",
    "  } catch {}",
    "})",
    "Yaz-Log ('form aciliyor x=' + $form.Left + ' y=' + $form.Top)",
    "[void]$form.ShowDialog()",
    "Yaz-Log ('form kapandi sonuc=' + $script:sonuc)",
    "if ($script:sonuc -eq 'tamam') {",
    "  foreach ($x in $liste) { if ([string]$x.id -eq $Id) { $x.gonderildi = $true } }",
    "  Kaydet-Liste $liste",
    "  Unregister-ScheduledTask -TaskName ('VegaRaporlama\\H-' + $Id) -Confirm:$false -ErrorAction SilentlyContinue",
    "} else {",
    "  $yeni = Get-Date",
    "  if ($script:sonuc -eq 'yarin') { $yeni = $yeni.AddDays(1) }",
    "  elseif ($script:sonuc -match '^\\d+$') { $yeni = $yeni.AddMinutes([int]$script:sonuc) }",
    "  $yeniGun = $yeni.ToString('yyyy-MM-dd')",
    "  $yeniSaat = $yeni.ToString('HH:mm')",
    "  foreach ($x in $liste) {",
    "    if ([string]$x.id -eq $Id) {",
    "      $x.gun = $yeniGun; $x.saat = $yeniSaat; $x.gonderildi = $false",
    "    }",
    "  }",
    "  Kaydet-Liste $liste",
    "  Gorev-Kur $Id $yeni",
    "}",
  ].join("\r\n");
  writeFileSync(yol, Buffer.from(`\uFEFF${govde}`, "utf16le"));
  return yol;
}

function hatirlatmalariOku() {
  try {
    if (!existsSync(hatirlatmaDosya())) return [];
    const ham = JSON.parse(readFileSync(hatirlatmaDosya(), "utf8"));
    return Array.isArray(ham) ? ham : [];
  } catch {
    return [];
  }
}

function hatirlatmalariYaz(liste) {
  writeFileSync(hatirlatmaDosya(), JSON.stringify(liste, null, 2), "utf8");
}

function hatirlatmaGorevAd(id) {
  return "VegaRaporlama\\H-" + String(id).replace(/[^\w.-]/g, "").slice(0, 64);
}

async function hatirlatmaGorevSil(id) {
  const ad = hatirlatmaGorevAd(id);
  try {
    await execFileAsync("powershell.exe", [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command",
      `Unregister-ScheduledTask -TaskName '${ad.replace(/'/g, "''")}' -Confirm:$false -ErrorAction SilentlyContinue`,
    ], { windowsHide: true });
  } catch { /* görev yok */ }
}

function hatirlatmaDogumGunuMu(item) {
  const metin = String(item?.metin || "");
  if (/doğum\s*günü|dogum\s*gunu|birthday/i.test(metin)) return true;
  return String(item?.googleEventType || "").toLowerCase() === "birthday";
}

async function hatirlatmaGorevKur(item, zorlaZaman) {
  const id = String(item.id || "").trim();
  if (!id || !item.gun || item.gonderildi) return;
  if (hatirlatmaDogumGunuMu(item)) {
    await hatirlatmaGorevSil(id);
    return;
  }
  const saat = String(item.saat || "09:00").trim() || "09:00";
  const zaman = zorlaZaman || new Date(`${item.gun}T${saat}:00`);
  if (!Number.isFinite(zaman.getTime())) return;
  // Saati geçmiş hatırlatma bir daha uyarmaz
  if (zaman.getTime() <= Date.now() - 15000) {
    await hatirlatmaGorevSil(id);
    return;
  }
  await hatirlatmaGorevSil(id);
  hatirlatmaGosterPs1();
  const vbs = join(hatirlatmaKok(), "goster.vbs");
  const ad = hatirlatmaGorevAd(id);
  const yil = zaman.getFullYear();
  const ay = zaman.getMonth() + 1;
  const gun = zaman.getDate();
  const saatNo = zaman.getHours();
  const dk = zaman.getMinutes();
  const sn = zaman.getSeconds();
  const arg = hatirlatmaGorevArg(vbs, id).replace(/'/g, "''");
  const kullanici = String(process.env.USERNAME || "").replace(/'/g, "''");
  const komut = [
    `$t = Get-Date -Year ${yil} -Month ${ay} -Day ${gun} -Hour ${saatNo} -Minute ${dk} -Second ${sn}`,
    `if ($t -le (Get-Date).AddSeconds(-30)) { Unregister-ScheduledTask -TaskName '${ad.replace(/'/g, "''")}' -Confirm:$false -ErrorAction SilentlyContinue; return }`,
    `$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument '${arg}'`,
    `$trigger = New-ScheduledTaskTrigger -Once -At $t`,
    `try { $trigger.EndBoundary = $t.AddHours(12).ToString('s') } catch {}`,
    `$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 1)`,
    `$principal = New-ScheduledTaskPrincipal -UserId '${kullanici || "$env:USERNAME"}' -LogonType Interactive -RunLevel Limited`,
    `Register-ScheduledTask -TaskName '${ad.replace(/'/g, "''")}' -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null`,
  ].join("; ");
  await execFileAsync("powershell.exe", [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-Command", komut,
  ], { windowsHide: true });
}

async function hatirlatmaGorevleriniSenkronize() {
  hatirlatmaGosterPs1();
  const ham = hatirlatmalariOku();
  const liste = [];
  let degisti = false;
  for (const item of ham) {
    if (!hatirlatmaDogumGunuMu(item)) {
      liste.push(item);
      continue;
    }
    degisti = true;
    try { await hatirlatmaGorevSil(item.id); } catch { /* görev yok */ }
  }
  if (degisti) hatirlatmalariYaz(liste);
  for (const item of liste) {
    if (item.gonderildi) {
      await hatirlatmaGorevSil(item.id);
      continue;
    }
    try {
      const onceGun = item.gun;
      const onceSaat = item.saat;
      await hatirlatmaGorevKur(item);
      if (item.gun !== onceGun || item.saat !== onceSaat) degisti = true;
    } catch { /* görev kurulamadı */ }
  }
  if (degisti) hatirlatmalariYaz(liste);
}

function googleKok() {
  const local = process.env.LOCALAPPDATA || uygulamaKok();
  const yol = join(local, "Vega Raporlama", "google");
  if (!existsSync(yol)) mkdirSync(yol, { recursive: true });
  return yol;
}

function googleAyarDosya() {
  return join(googleKok(), "ayar.json");
}

function googleTokenDosya() {
  return join(googleKok(), "token.json");
}

function googleAyarOku() {
  try {
    if (!existsSync(googleAyarDosya())) {
      return {
        clientId: String(process.env.GOOGLE_CLIENT_ID || "").trim(),
        clientSecret: String(process.env.GOOGLE_CLIENT_SECRET || "").trim(),
        apiKey: String(process.env.GOOGLE_API_KEY || "").trim(),
        calendarId: "primary",
        autoSync: true,
        autoSyncDk: 15,
      };
    }
    const ham = JSON.parse(readFileSync(googleAyarDosya(), "utf8"));
    const dk = Number(ham.autoSyncDk);
    return {
      clientId: String(ham.clientId || process.env.GOOGLE_CLIENT_ID || "").trim(),
      clientSecret: String(ham.clientSecret || process.env.GOOGLE_CLIENT_SECRET || "").trim(),
      apiKey: String(ham.apiKey || process.env.GOOGLE_API_KEY || "").trim(),
      calendarId: String(ham.calendarId || "primary").trim() || "primary",
      autoSync: ham.autoSync !== false,
      autoSyncDk: Number.isFinite(dk) && dk >= 5 ? Math.min(240, Math.floor(dk)) : 15,
    };
  } catch {
    return { clientId: "", clientSecret: "", apiKey: "", calendarId: "primary", autoSync: true, autoSyncDk: 15 };
  }
}

function googleAyarYaz(ayar) {
  const once = googleAyarOku();
  const dkHam = ayar.autoSyncDk != null ? Number(ayar.autoSyncDk) : once.autoSyncDk;
  const yeni = {
    clientId: String(ayar.clientId != null ? ayar.clientId : once.clientId || "").trim(),
    clientSecret: String(ayar.clientSecret != null ? ayar.clientSecret : once.clientSecret || "").trim(),
    apiKey: String(ayar.apiKey != null ? ayar.apiKey : once.apiKey || "").trim(),
    calendarId: String(ayar.calendarId != null ? ayar.calendarId : once.calendarId || "primary").trim() || "primary",
    autoSync: ayar.autoSync != null ? Boolean(ayar.autoSync) : once.autoSync !== false,
    autoSyncDk: Number.isFinite(dkHam) && dkHam >= 5 ? Math.min(240, Math.floor(dkHam)) : 15,
  };
  writeFileSync(googleAyarDosya(), JSON.stringify(yeni, null, 2), "utf8");
  googleOtomatikSenkronKur();
  googleArkaPlanGorevSenkronize().catch(() => {});
  return yeni;
}

function googleBaglamDosya() {
  return join(googleKok(), "baglam.json");
}

function googleBaglamOku() {
  try {
    if (!existsSync(googleBaglamDosya())) return { firma: 0, donem: 0 };
    const ham = JSON.parse(readFileSync(googleBaglamDosya(), "utf8"));
    return { firma: tamSayi(ham.firma) || 0, donem: tamSayi(ham.donem) || 0 };
  } catch {
    return { firma: 0, donem: 0 };
  }
}

function googleBaglamYaz(baglam) {
  const firma = tamSayi(baglam?.firma) || 0;
  const donem = tamSayi(baglam?.donem) || 0;
  if (!firma || !donem) return googleBaglamOku();
  const yeni = { firma, donem, zaman: new Date().toISOString() };
  try { writeFileSync(googleBaglamDosya(), JSON.stringify(yeni, null, 2), "utf8"); } catch { /* ok */ }
  return yeni;
}

function googleSenkronKilitDosya() {
  return join(googleKok(), "senkron.lock");
}

function googleSenkronKilitAl() {
  const yol = googleSenkronKilitDosya();
  try {
    if (existsSync(yol)) {
      const yas = Date.now() - (statSync(yol).mtimeMs || 0);
      if (yas < 5 * 60 * 1000) return false;
    }
    writeFileSync(yol, String(process.pid) + " " + new Date().toISOString(), "utf8");
    return true;
  } catch {
    return false;
  }
}

function googleSenkronKilitBirak() {
  try { if (existsSync(googleSenkronKilitDosya())) unlinkSync(googleSenkronKilitDosya()); } catch { /* ok */ }
}

function googleArkaPlanGorevAd() {
  return "VegaRaporlama\\GoogleSenkron";
}

function googleArkaPlanKomut() {
  if (paketMi() || /VegaRaporlama\.exe$/i.test(basename(process.execPath || ""))) {
    return { exe: process.execPath, args: ["--google-senkron-arka"] };
  }
  const nodeExe = process.execPath || "node";
  const script = join(__dirname, "server.js");
  return { exe: nodeExe, args: [script, "--google-senkron-arka"] };
}

async function googleArkaPlanGorevSil() {
  const ad = googleArkaPlanGorevAd();
  try {
    await execFileAsync("powershell.exe", [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-Command",
      `Unregister-ScheduledTask -TaskName '${ad.replace(/'/g, "''")}' -Confirm:$false -ErrorAction SilentlyContinue`,
    ], { windowsHide: true });
  } catch { /* yok */ }
}

async function googleArkaPlanGorevKur() {
  const ayar = googleAyarOku();
  if (!ayar.autoSync || !googleDurum().bagli) {
    await googleArkaPlanGorevSil();
    return false;
  }
  const dk = Math.max(5, Number(ayar.autoSyncDk) || 15);
  const komut = googleArkaPlanKomut();
  const ad = googleArkaPlanGorevAd();
  const exe = String(komut.exe || "").replace(/'/g, "''");
  const argStr = (komut.args || []).map((a) => String(a).replace(/'/g, "''")).join(" ");
  const kullanici = String(process.env.USERNAME || "").replace(/'/g, "''");
  const ps = [
    `$ad = '${ad.replace(/'/g, "''")}'`,
    `Unregister-ScheduledTask -TaskName $ad -Confirm:$false -ErrorAction SilentlyContinue`,
    `$action = New-ScheduledTaskAction -Execute '${exe}' -Argument '${argStr}'`,
    `$bas = (Get-Date).AddMinutes(1)`,
    `$trigger = New-ScheduledTaskTrigger -Once -At $bas -RepetitionInterval (New-TimeSpan -Minutes ${dk}) -RepetitionDuration ([TimeSpan]::FromDays(3650))`,
    `$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -MultipleInstances IgnoreNew`,
    `$principal = New-ScheduledTaskPrincipal -UserId '${kullanici || "$env:USERNAME"}' -LogonType Interactive -RunLevel Limited`,
    `Register-ScheduledTask -TaskName $ad -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null`,
  ].join("; ");
  await execFileAsync("powershell.exe", [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-Command", ps,
  ], { windowsHide: true });
  return true;
}

async function googleArkaPlanGorevSenkronize() {
  try {
    return await googleArkaPlanGorevKur();
  } catch {
    try { await googleArkaPlanGorevSil(); } catch { /* ok */ }
    return false;
  }
}

let googleOtomatikZaman = null;
let googleOtomatikCalisiyor = false;
let googleSonSenkron = null;

function googleSonSenkronDosya() {
  return join(googleKok(), "son-senkron.json");
}

function googleSonSenkronOku() {
  try {
    if (googleSonSenkron) return googleSonSenkron;
    if (!existsSync(googleSonSenkronDosya())) return null;
    googleSonSenkron = JSON.parse(readFileSync(googleSonSenkronDosya(), "utf8"));
    return googleSonSenkron;
  } catch {
    return null;
  }
}

function googleSonSenkronYaz(kayit) {
  googleSonSenkron = kayit;
  try { writeFileSync(googleSonSenkronDosya(), JSON.stringify(kayit, null, 2), "utf8"); } catch { /* ok */ }
}

let googleOtomatikIs = null;

function googleKilitBekle(ms) {
  const son = Date.now() + ms;
  return new Promise((resolve) => {
    const dene = () => {
      if (googleSenkronKilitAl()) {
        resolve(true);
        return;
      }
      if (Date.now() >= son) {
        resolve(false);
        return;
      }
      setTimeout(dene, 400);
    };
    dene();
  });
}

async function googleOtomatikSenkronCalistir(kaynak = "otomatik", baglam = {}) {
  if (googleOtomatikIs) {
    if (kaynak === "manuel" || kaynak === "baglanti") return googleOtomatikIs;
    return null;
  }
  if (!googleDurum().bagli) return null;
  const ayar = googleAyarOku();
  if ((kaynak === "otomatik" || kaynak === "arka-plan" || kaynak === "baslangic") && ayar.autoSync === false) return null;
  const is = (async () => {
    const bekleyen = kaynak === "manuel" || kaynak === "baglanti";
    const kilit = bekleyen ? await googleKilitBekle(20000) : googleSenkronKilitAl();
    if (!kilit) return null;
    googleOtomatikCalisiyor = true;
    try {
      const kayitli = googleBaglamOku();
      const birlesik = {
        firma: tamSayi(baglam.firma) || kayitli.firma,
        donem: tamSayi(baglam.donem) || kayitli.donem,
      };
      if (birlesik.firma && birlesik.donem) googleBaglamYaz(birlesik);
      const sonuc = await googleHatirlatmalariSenkronize(birlesik);
      googleSonSenkronYaz({
        zaman: new Date().toISOString(),
        kaynak,
        ...sonuc,
      });
      return sonuc;
    } catch (error) {
      googleSonSenkronYaz({
        zaman: new Date().toISOString(),
        kaynak,
        hata: error.message || "Senkron hatası",
      });
      return null;
    } finally {
      googleOtomatikCalisiyor = false;
      googleSenkronKilitBirak();
    }
  })();
  googleOtomatikIs = is;
  is.finally(() => {
    if (googleOtomatikIs === is) googleOtomatikIs = null;
  });
  return is;
}

function googleOtomatikSenkronKur() {
  if (googleOtomatikZaman) {
    clearInterval(googleOtomatikZaman);
    googleOtomatikZaman = null;
  }
  const ayar = googleAyarOku();
  if (!ayar.autoSync) return;
  // Uygulama açıkken telefon notu bir dakika içinde gelsin. Arka plan görevi ayardaki süreyi kullanır.
  const ms = 60 * 1000;
  googleOtomatikZaman = setInterval(() => {
    googleOtomatikSenkronCalistir("otomatik").catch(() => {});
  }, ms);
  if (googleOtomatikZaman.unref) googleOtomatikZaman.unref();
}

function googleClientSecretParse(ham) {
  const obj = typeof ham === "string" ? JSON.parse(ham) : ham;
  const apiKey = String(obj.api_key || obj.apiKey || obj.key || "").trim();
  const blok = obj.web || obj.installed || obj;
  const clientId = String(blok.client_id || blok.clientId || "").trim();
  const clientSecret = String(blok.client_secret || blok.clientSecret || "").trim();
  if (apiKey && (!clientId || !clientSecret)) {
    return { clientId: "", clientSecret: "", apiKey, tip: "apiKey" };
  }
  if (!clientId || !clientSecret) throw new Error("JSON içinde client_id / client_secret veya api_key bulunamadı.");
  return {
    clientId,
    clientSecret,
    apiKey,
    tip: obj.web ? "web" : (obj.installed ? "installed" : "diger"),
  };
}

function googleIndirilenSecretYollari() {
  const home = process.env.USERPROFILE || process.env.HOME || "";
  const downloads = join(home, "Downloads");
  const adaylar = [];
  if (existsSync(downloads)) {
    try {
      for (const ad of readdirSync(downloads)) {
        if (/^client_secret_.*\.apps\.googleusercontent\.com\.json$/i.test(ad) || /^client_secret_.*\.json$/i.test(ad)) {
          adaylar.push(join(downloads, ad));
        }
      }
    } catch { /* okunamadı */ }
  }
  // Masaüstü (installed) istemci önce — Web istemcisi redirect_uri_mismatch verir
  return adaylar.sort((a, b) => {
    let tipA = 0;
    let tipB = 0;
    try {
      const pa = googleClientSecretParse(readFileSync(a, "utf8"));
      const pb = googleClientSecretParse(readFileSync(b, "utf8"));
      tipA = pa.tip === "installed" ? 2 : (pa.tip === "web" ? 0 : 1);
      tipB = pb.tip === "installed" ? 2 : (pb.tip === "web" ? 0 : 1);
    } catch { /* ok */ }
    if (tipA !== tipB) return tipB - tipA;
    try { return statSync(b).mtimeMs - statSync(a).mtimeMs; } catch { return 0; }
  });
}

function googleKayitliIstemciTipi() {
  try {
    const yol = join(googleKok(), "client_secret.json");
    if (!existsSync(yol)) return "";
    return googleClientSecretParse(readFileSync(yol, "utf8")).tip || "";
  } catch {
    return "";
  }
}

function googleTokenOku() {
  try {
    if (!existsSync(googleTokenDosya())) return null;
    return JSON.parse(readFileSync(googleTokenDosya(), "utf8"));
  } catch {
    return null;
  }
}

function googleTokenYaz(token) {
  writeFileSync(googleTokenDosya(), JSON.stringify(token, null, 2), "utf8");
}

function googleTokenSil() {
  try { if (existsSync(googleTokenDosya())) unlinkSync(googleTokenDosya()); } catch { /* yok */ }
}

function googleRedirectUri() {
  return `http://127.0.0.1:${PORT}/api/google/callback`;
}

let googleOAuthState = "";
let googleBaglantiUyari = "";

function googleTokenGecersizMi(mesaj, kod) {
  const yazi = String(mesaj || "").toLowerCase();
  const hata = String(kod || "").toLowerCase();
  return hata === "invalid_grant"
    || yazi.includes("invalid_grant")
    || yazi.includes("expired or revoked")
    || yazi.includes("token has been expired");
}

function googleTokenDusur() {
  googleTokenSil();
  googleBaglantiUyari = "Google bağlantısının süresi dolmuş veya iptal edilmiş. Google ile bağla’ya basıp yeniden izin verin.";
  googleArkaPlanGorevSil().catch(() => {});
}

function googleSonTelefonNotu() {
  let sec = null;
  for (const item of hatirlatmalariOku()) {
    if (!item || item.onceAnaId) continue;
    if (item.kaynak !== "google" && item.kaynak !== "google-task") continue;
    const zaman = String(item.guncelleme || item.olusturma || "");
    if (sec && zaman <= sec.zaman) continue;
    sec = {
      zaman,
      gun: item.gun || "",
      saat: item.saat || "",
      metin: String(item.metin || "").slice(0, 80),
    };
  }
  return sec;
}

function googleDurum() {
  const ayar = googleAyarOku();
  const token = googleTokenOku();
  const son = googleSonSenkronOku();
  const oauthAyarli = Boolean(ayar.clientId && ayar.clientSecret);
  const apiKeyAyarli = Boolean(ayar.apiKey);
  return {
    ayarli: oauthAyarli || apiKeyAyarli,
    oauthAyarli,
    apiKeyAyarli,
    apiKeyMaske: apiKeyAyarli ? (ayar.apiKey.slice(0, 6) + "…" + ayar.apiKey.slice(-4)) : "",
    bagli: Boolean(token && token.refresh_token),
    email: token?.email || "",
    calendarId: ayar.calendarId || "primary",
    redirectUri: googleRedirectUri(),
    autoSync: ayar.autoSync !== false,
    autoSyncDk: ayar.autoSyncDk || 15,
    arkaPlan: ayar.autoSync !== false && Boolean(token && token.refresh_token),
    sonSenkron: son,
    sonTelefon: googleSonTelefonNotu(),
    baglantiUyari: token?.refresh_token ? "" : googleBaglantiUyari,
  };
}

async function googleTokenYenile() {
  const ayar = googleAyarOku();
  const token = googleTokenOku();
  if (!ayar.clientId || !ayar.clientSecret) throw new Error("Google Client ID / Secret gerekli.");
  if (!token?.refresh_token) throw new Error("Google bağlı değil. Önce bağlanın.");
  if (token.expiry && Date.now() < Number(token.expiry) - 60000 && token.access_token) {
    return token.access_token;
  }
  const govde = new URLSearchParams({
    client_id: ayar.clientId,
    client_secret: ayar.clientSecret,
    refresh_token: token.refresh_token,
    grant_type: "refresh_token",
  });
  const yanit = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: govde.toString(),
  });
  const data = await yanit.json();
  if (!yanit.ok) {
    const mesaj = data.error_description || data.error || "Google token yenilenemedi.";
    if (googleTokenGecersizMi(mesaj, data.error)) {
      googleTokenDusur();
      throw new Error(googleBaglantiUyari);
    }
    throw new Error(mesaj);
  }
  const yeni = {
    ...token,
    access_token: data.access_token,
    expiry: Date.now() + (Number(data.expires_in) || 3600) * 1000,
  };
  if (data.refresh_token) yeni.refresh_token = data.refresh_token;
  if (!yeni.email) yeni.email = await googleEmailGetir(yeni.access_token);
  googleTokenYaz(yeni);
  return yeni.access_token;
}

function googleApiUrl(yol) {
  const ayar = googleAyarOku();
  const temel = "https://www.googleapis.com/calendar/v3" + yol;
  if (!ayar.apiKey) return temel;
  return temel + (temel.includes("?") ? "&" : "?") + "key=" + encodeURIComponent(ayar.apiKey);
}

async function googleApi(yol, secenek = {}) {
  const access = await googleTokenYenile();
  const yanit = await fetch(googleApiUrl(yol), {
    ...secenek,
    headers: {
      Authorization: "Bearer " + access,
      "Content-Type": "application/json",
      ...(secenek.headers || {}),
    },
  });
  if (yanit.status === 204) return null;
  const text = await yanit.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!yanit.ok) {
    const msg = (data && (data.error?.message || data.error_description || (typeof data.error === "string" ? data.error : ""))) || ("Google API " + yanit.status);
    if (yanit.status === 401 && googleTokenGecersizMi(msg, data && data.error)) {
      googleTokenDusur();
      throw new Error(googleBaglantiUyari);
    }
    const err = new Error(msg);
    err.status = yanit.status;
    err.details = data;
    throw err;
  }
  return data;
}

async function googleTasksApi(yol, secenek = {}) {
  const access = await googleTokenYenile();
  // API key ekleme: kısıtlı anahtar Tasks’i “blocked” yapar; yalnızca OAuth kullan.
  const adres = "https://tasks.googleapis.com/tasks/v1" + yol;
  const yanit = await fetch(adres, {
    ...secenek,
    headers: {
      Authorization: "Bearer " + access,
      "Content-Type": "application/json",
      ...(secenek.headers || {}),
    },
  });
  if (yanit.status === 204) return null;
  const text = await yanit.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!yanit.ok) {
    const msg = (data && (data.error?.message || data.error_description || (typeof data.error === "string" ? data.error : ""))) || ("Google Tasks " + yanit.status);
    const err = new Error(msg);
    err.status = yanit.status;
    err.details = data;
    throw err;
  }
  return data;
}

async function googleHatirlatmaUzaktaSil(item) {
  if (!item || !googleDurum().bagli) return false;
  let sildi = false;
  const tip = String(item.googleEventType || "default").toLowerCase();
  const takvimNotu = tip !== "birthday" && tip !== "workinglocation" && tip !== "fromgmail";
  if (item.googleEventId && takvimNotu) {
    const ayar = googleAyarOku();
    const hedef = encodeURIComponent(item.googleCalendarId || ayar.calendarId || "primary");
    try {
      await googleApi("/calendars/" + hedef + "/events/" + encodeURIComponent(item.googleEventId), { method: "DELETE" });
      sildi = true;
    } catch (error) {
      const msg = String(error.message || "");
      if (error.status !== 404 && !/Not Found|notFound|deleted/i.test(msg)) throw error;
    }
  }
  if (item.googleTaskId) {
    const liste = encodeURIComponent(item.googleTaskListId || "@default");
    try {
      await googleTasksApi("/lists/" + liste + "/tasks/" + encodeURIComponent(item.googleTaskId), { method: "DELETE" });
      sildi = true;
    } catch (error) {
      const msg = String(error.message || "");
      if (error.status !== 404 && !/Not Found|notFound|deleted/i.test(msg)) throw error;
    }
  }
  return sildi;
}

function googleGorevZamanParcala(gorev) {
  // Tasks API: due yalnızca gün; saat API’de yok. Başlık/notta saat varsa onu kullan.
  // Tarihsiz görevi “şimdi” yapma — toplu uyarı patlatır.
  const due = String(gorev?.due || "").trim();
  let gun = "";
  let saat = "";
  const istanbulGun = (iso) => {
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return "";
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Istanbul",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(d);
    const al = (t) => (parts.find((p) => p.type === t) || {}).value || "";
    return {
      gun: al("year") + "-" + String(al("month")).padStart(2, "0") + "-" + String(al("day")).padStart(2, "0"),
      saat: String(Math.min(23, Number(al("hour")) || 0)).padStart(2, "0") + ":" + String(Math.min(59, Number(al("minute")) || 0)).padStart(2, "0"),
    };
  };
  if (/^\d{4}-\d{2}-\d{2}/.test(due)) {
    // due her zaman T00:00:00Z → takvim günü olarak ilk 10 karakter
    gun = due.slice(0, 10);
  }
  let metin = [gorev?.title, gorev?.notes].filter(Boolean).join(" ");
  // Dışa aktarımda eklenen "HH:MM metin" önekini tekrar saat sanma (Vega notu varsa)
  if (/Vega Raporlama/i.test(String(gorev?.notes || ""))) {
    metin = String(gorev?.title || "").replace(/^\s*\d{1,2}[:\.]\d{2}\s+/, "").trim()
      + " " + String(gorev?.notes || "");
  }
  const saatBul = metin.match(/(?:saat\s*)?\b([01]?\d|2[0-3])[:\.]([0-5]\d)\b/i);
  if (saatBul) {
    saat = String(saatBul[1]).padStart(2, "0") + ":" + saatBul[2];
  } else if (due.length > 10) {
    const z = istanbulGun(due);
    if (z.gun) {
      if (!gun) gun = z.gun;
      if (z.saat !== "00:00") saat = z.saat;
    }
  }
  if (!gun) {
    // Telefondaki tarihsiz anımsatma da bugünün listesine gelsin.
    const bugun = istanbulGun(new Date().toISOString());
    gun = bugun.gun || "";
    if (!saat) saat = "09:00";
  }
  if (!gun) return null;
  if (!saat) saat = "09:00";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(gun) || !/^\d{2}:\d{2}$/.test(saat)) return null;
  return { gun, saat };
}

async function googleGorevListeleri() {
  const listeler = [];
  let pageToken = "";
  do {
    const params = new URLSearchParams({ maxResults: "100" });
    if (pageToken) params.set("pageToken", pageToken);
    const data = await googleTasksApi("/users/@me/lists?" + params.toString());
    for (const L of data.items || []) {
      if (L?.id) listeler.push(L);
    }
    pageToken = data.nextPageToken || "";
  } while (pageToken);
  return listeler.length ? listeler : [{ id: "@default", title: "Varsayılan" }];
}

async function googleGorevleriCek() {
  const listeler = await googleGorevListeleri();
  const gorevler = [];
  for (const L of listeler) {
    let pageToken = "";
    do {
      const params = new URLSearchParams({
        showCompleted: "false",
        showHidden: "false",
        maxResults: "100",
      });
      if (pageToken) params.set("pageToken", pageToken);
      const data = await googleTasksApi("/lists/" + encodeURIComponent(L.id) + "/tasks?" + params.toString());
      for (const g of data.items || []) {
        if (!g || !g.id || g.deleted || g.status === "completed") continue;
        gorevler.push({ ...g, _listId: L.id, _listTitle: L.title || "" });
      }
      pageToken = data.nextPageToken || "";
    } while (pageToken);
  }
  return gorevler;
}

async function googleGorevleriIceAktar(liste) {
  let iceEklenen = 0;
  let iceGuncellenen = 0;
  const gorevler = await googleGorevleriCek();
  const byTaskId = new Map();
  for (const item of liste) {
    if (item.googleTaskId) byTaskId.set(String(item.googleTaskId), item);
  }
  for (const gorev of gorevler) {
    const zaman = googleGorevZamanParcala(gorev);
    if (!zaman) continue;
    const metin = String(gorev.title || "").trim() || String(gorev.notes || "").trim() || "Google görev";
    if (!metin) continue;
    let item = byTaskId.get(String(gorev.id));
    if (item) {
      if (item.onceAnaId) continue;
      const degisti =
        String(item.gun) !== zaman.gun
        || String(item.saat || "") !== zaman.saat
        || String(item.metin || "") !== metin.slice(0, 500);
      item.googleTaskId = gorev.id;
      item.googleTaskListId = gorev._listId || item.googleTaskListId || "@default";
      item.kaynak = item.kaynak || "google-task";
      if (!degisti) continue;
      item.gun = zaman.gun;
      item.saat = zaman.saat;
      item.metin = metin.slice(0, 500);
      item.gonderildi = false;
      item.guncelleme = new Date().toISOString();
      try { await hatirlatmaGorevKur(item); } catch { /* ok */ }
      iceGuncellenen += 1;
      continue;
    }
    item = {
      id: randomBytes(6).toString("hex"),
      gun: zaman.gun,
      saat: zaman.saat,
      metin: metin.slice(0, 500),
      gonderildi: false,
      olusturma: new Date().toISOString(),
      guncelleme: new Date().toISOString(),
      googleTaskId: gorev.id,
      googleTaskListId: gorev._listId || "@default",
      kaynak: "google-task",
      onceGun: 0,
    };
    liste.push(item);
    byTaskId.set(String(gorev.id), item);
    try { await hatirlatmaGorevKur(item); } catch { /* ok */ }
    iceEklenen += 1;
  }
  return { iceEklenen, iceGuncellenen };
}

function googleGorevGovde(item) {
  const gun = String(item.gun || "").trim();
  const saat = String(item.saat || "09:00").trim();
  let metin = String(item.metin || "Vega hatirlatma").trim().slice(0, 200);
  // Google’dan gelen başlığı bozma; yalnızca programdan yazılanlara saat öneki
  if (item.kaynak === "google-task") {
    metin = metin.replace(/^\s*\d{1,2}[:\.]\d{2}\s+/, "").trim() || metin;
    return {
      title: metin.slice(0, 200),
      notes: String(item.googleTaskNotes || "").slice(0, 8000),
      due: gun + "T00:00:00.000Z",
      status: item.gonderildi ? "completed" : "needsAction",
    };
  }
  const baslik = (/^\d{2}:\d{2}/.test(metin) ? metin : (saat + " " + metin)).slice(0, 200);
  return {
    title: baslik,
    notes: "Vega Raporlama\nTarih: " + gun + " " + saat,
    due: gun + "T00:00:00.000Z",
    status: item.gonderildi ? "completed" : "needsAction",
  };
}

async function googleGorevleriDisaAktar(liste) {
  let eklenen = 0;
  let guncellenen = 0;
  let hata = 0;
  const hatalar = [];
  let listId = "@default";
  try {
    const listeler = await googleGorevListeleri();
    listId = listeler[0]?.id || "@default";
  } catch (error) {
    return { eklenen: 0, guncellenen: 0, hata: 1, hatalar: [error.message || "Görev listesi yok"] };
  }
  for (const item of liste) {
    if (item.onceAnaId) continue;
    if (item.kaynak === "odeme-takvim" || item.kaynak === "teklif") continue; // çek/senet/visa ve teklif → yalnızca takvim + yerel hatırlatma
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(item.gun || ""))) continue;
    // Takvimden gelen özel olayları görev yapma
    if (item.kaynak === "google" && item.googleEventId && !item.googleTaskId) continue;
    try {
      const govde = googleGorevGovde(item);
      const imza = googleIcerikImza(govde);
      const sonZaman = Date.parse(googleSonSenkronOku()?.zaman || "") || 0;
      if (!googleYazmaGerekli(item, imza, "googleTaskId", "googleGorevImza", sonZaman)) continue;
      const hedefListe = item.googleTaskListId || listId;
      if (item.googleTaskId) {
        await googleTasksApi(
          "/lists/" + encodeURIComponent(hedefListe) + "/tasks/" + encodeURIComponent(item.googleTaskId),
          { method: "PATCH", body: JSON.stringify(govde) }
        );
        item.googleGorevImza = imza;
        guncellenen += 1;
      } else if (!item.gonderildi) {
        const olusan = await googleTasksApi(
          "/lists/" + encodeURIComponent(hedefListe) + "/tasks",
          { method: "POST", body: JSON.stringify(govde) }
        );
        item.googleTaskId = olusan.id;
        item.googleTaskListId = hedefListe;
        item.googleGorevImza = imza;
        eklenen += 1;
      }
    } catch (error) {
      hata += 1;
      if (hatalar.length < 5) hatalar.push((item.gun || "?") + " görev: " + (error.message || ""));
    }
  }
  return { eklenen, guncellenen, hata, hatalar };
}

async function googleApiKeyDogrula() {
  const ayar = googleAyarOku();
  if (!ayar.apiKey) throw new Error("API anahtarı kayıtlı değil.");
  // Calendar API’nin projede açık ve anahtarın geçerli olduğunu dener.
  const yanit = await fetch(
    "https://www.googleapis.com/calendar/v3/calendars/primary?key=" + encodeURIComponent(ayar.apiKey),
    { headers: { "User-Agent": "VegaRaporlama/" + UYGULAMA_SURUM } }
  );
  const text = await yanit.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (yanit.ok) {
    return { ok: true, mesaj: "API anahtarı geçerli. Takvim senkronu için Google ile bağla (OAuth) da gerekir." };
  }
  const sebep = String(data?.error?.errors?.[0]?.reason || "");
  const msg = String(data?.error?.message || "");
  // Anahtar geçerli ama private takvim için login ister → API tarafı çalışıyor sayılır.
  if (yanit.status === 401 || /loginRequired|authError|unauthorized/i.test(sebep + " " + msg)) {
    return { ok: true, mesaj: "API anahtarı kabul edildi. Kişisel takvim için Google ile bağla’ya basın." };
  }
  if (/API key not valid|API_KEY_INVALID|keyInvalid/i.test(sebep + " " + msg)) {
    throw new Error("API anahtarı geçersiz. Cloud Console → Credentials → API key kontrol edin.");
  }
  if (/accessNotConfigured|Calendar API has not been used|disabled/i.test(sebep + " " + msg)) {
    throw new Error("Google Calendar API bu projede kapalı. Cloud Console’da Calendar API’yi etkinleştirin.");
  }
  throw new Error(msg || ("API anahtarı doğrulanamadı (" + yanit.status + ")."));
}

async function googleEmailGetir(accessToken) {
  try {
    const yanit = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: "Bearer " + accessToken },
    });
    const data = await yanit.json();
    return data.email || "";
  } catch {
    return "";
  }
}

function googleOlayGovde(item) {
  const saatHam = String(item.saat || "09:00").trim();
  let saat = /^\d{2}:\d{2}$/.test(saatHam) ? saatHam : "09:00";
  let [sa, dk] = saat.split(":").map((x) => Number(x));
  if (!Number.isFinite(sa) || sa < 0 || sa > 23 || !Number.isFinite(dk) || dk < 0 || dk > 59) {
    saat = "09:00";
    sa = 9;
    dk = 0;
  }
  const gun = String(item.gun || "").trim();
  const [y, m, d] = gun.split("-").map((x) => Number(x));
  // Saat Istanbul saati; dateTime'ı olduğu gibi yaz (+30 dk bitiş)
  const basStr = gun + "T" + saat + ":00";
  let bitSa = sa;
  let bitDk = dk + 30;
  let bitGun = gun;
  if (bitDk >= 60) { bitSa += Math.floor(bitDk / 60); bitDk = bitDk % 60; }
  if (bitSa >= 24) {
    bitSa -= 24;
    const nd = new Date(y, (m || 1) - 1, (d || 1) + 1);
    bitGun = nd.getFullYear() + "-" + String(nd.getMonth() + 1).padStart(2, "0") + "-" + String(nd.getDate()).padStart(2, "0");
  }
  const bitStr = bitGun + "T" + String(bitSa).padStart(2, "0") + ":" + String(bitDk).padStart(2, "0") + ":00";
  return {
    summary: String(item.metin || "Vega hatirlatma").slice(0, 200),
    description: "Vega Raporlama hatirlatmasi\nTarih: " + gun + " " + saat,
    start: { dateTime: basStr, timeZone: "Europe/Istanbul" },
    end: { dateTime: bitStr, timeZone: "Europe/Istanbul" },
    // popup = telefonda Google Takvim bildirimi (varsayılan hatırlatmaya güvenme)
    reminders: {
      useDefault: false,
      overrides: (() => {
        const liste = [
          { method: "popup", minutes: 0 },
          { method: "popup", minutes: 10 },
          { method: "email", minutes: 10 },
        ];
        const once = Math.min(30, Math.max(0, Number(item.onceGun) || 0));
        if (once > 0) {
          const onceDk = once * 24 * 60;
          liste.push({ method: "popup", minutes: onceDk });
          liste.push({ method: "email", minutes: onceDk });
        }
        return liste;
      })(),
    },
    extendedProperties: { private: { vegaId: String(item.id) } },
  };
}

function googleIcerikImza(govde) {
  return createHash("sha1").update(JSON.stringify(govde)).digest("hex").slice(0, 20);
}

function googleYazmaGerekli(item, imza, idAlan, imzaAlan, sonZaman) {
  if (!item[idAlan]) return true;
  if (item[imzaAlan] === imza) return false;
  if (!item[imzaAlan]) {
    const yerel = Date.parse(item.guncelleme || item.olusturma || "") || 0;
    if (!(yerel > sonZaman + 2000)) {
      item[imzaAlan] = imza;
      return false;
    }
  }
  return true;
}

function googleOzelOlayMi(item, olay) {
  const tip = String(olay?.eventType || item?.googleEventType || "default").toLowerCase();
  if (tip && tip !== "default") return true;
  const metin = String(item?.metin || olay?.summary || "");
  if (/doğum\s*günü|dogum\s*gunu|birthday/i.test(metin)) return true;
  if (item?.googleSyncAtla || item?.googleGunBoyu) return true;
  // Tüm gün Google olayı — dateTime ile PATCH "Invalid start time" verir
  if (olay?.start?.date && !olay?.start?.dateTime) return true;
  return false;
}

function hatirlatmaGunKaydir(gun, gunSayisi) {
  const [y, m, d] = String(gun).split("-").map((x) => Number(x));
  const t = new Date(y, (m || 1) - 1, (d || 1) + Number(gunSayisi || 0));
  return t.getFullYear() + "-" + String(t.getMonth() + 1).padStart(2, "0") + "-" + String(t.getDate()).padStart(2, "0");
}

function hatirlatmaOnceBagliSenkron(liste, item) {
  const onceGun = Math.min(30, Math.max(0, Number(item.onceGun) || 0));
  item.onceGun = onceGun;
  const silinecek = [];
  const kurulacak = [];
  let bagli = null;
  if (item.onceBagliId) bagli = liste.find((row) => row.id === item.onceBagliId) || null;
  if (!bagli) bagli = liste.find((row) => row.onceAnaId === item.id) || null;
  if (!onceGun) {
    if (bagli) {
      silinecek.push(bagli.id);
      const ix = liste.findIndex((row) => row.id === bagli.id);
      if (ix >= 0) liste.splice(ix, 1);
    }
    delete item.onceBagliId;
    return { silinecek, kurulacak };
  }
  const onceTarih = hatirlatmaGunKaydir(item.gun, -onceGun);
  const metinOnce = String(item.metin || "") + " (" + onceGun + " gün önce)";
  if (bagli) {
    bagli.gun = onceTarih;
    bagli.saat = item.saat;
    bagli.metin = metinOnce;
    bagli.gonderildi = false;
    bagli.onceAnaId = item.id;
    bagli.onceGun = 0;
  } else {
    bagli = {
      id: randomBytes(6).toString("hex"),
      gun: onceTarih,
      saat: item.saat,
      metin: metinOnce,
      gonderildi: false,
      olusturma: new Date().toISOString(),
      onceAnaId: item.id,
      onceGun: 0,
    };
    liste.push(bagli);
  }
  item.onceBagliId = bagli.id;
  kurulacak.push(bagli);
  return { silinecek, kurulacak };
}

function hatirlatmaGorevleriniArkaPlanda(silinecek, kurulacak) {
  Promise.resolve().then(async () => {
    for (const sid of silinecek || []) {
      try { await hatirlatmaGorevSil(sid); } catch { /* görev yok */ }
    }
    for (const row of kurulacak || []) {
      try { await hatirlatmaGorevKur(row); } catch { /* kayıt dosyada durur, açılışta yeniden kurulur */ }
    }
  }).catch(() => {});
}

function googleOlayZamanParcala(olay) {
  const ham = olay?.start?.dateTime || olay?.start?.date || "";
  if (!ham) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(ham)) {
    return { gun: ham, saat: "09:00" };
  }
  const d = new Date(ham);
  if (!Number.isFinite(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Istanbul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const al = (tip) => (parts.find((p) => p.type === tip) || {}).value || "";
  const ay = String(al("month") || "").padStart(2, "0");
  const gunNo = String(al("day") || "").padStart(2, "0");
  const gun = al("year") + "-" + ay + "-" + gunNo;
  let sa = String(al("hour") || "0").replace(/^24$/, "0");
  let dk = String(al("minute") || "0");
  // Intl bazen "9:5" döndürür; Google/program "09:05" ister
  sa = String(Math.min(23, Math.max(0, Number(sa) || 0))).padStart(2, "0");
  dk = String(Math.min(59, Math.max(0, Number(dk) || 0))).padStart(2, "0");
  const saat = sa + ":" + dk;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(gun) || !/^\d{2}:\d{2}$/.test(saat)) return null;
  return { gun, saat };
}

async function googleYazilabilirTakvimler() {
  const ayar = googleAyarOku();
  const secili = String(ayar.calendarId || "primary");
  const liste = [];
  try {
    const data = await googleApi("/users/me/calendarList?maxResults=100");
    for (const takvim of data.items || []) {
      if (!takvim?.id) continue;
      const rol = String(takvim.accessRole || "");
      if (rol !== "owner" && rol !== "writer") continue;
      liste.push({ id: takvim.id, primary: Boolean(takvim.primary) });
    }
  } catch { /* seçili takvim */ }
  if (!liste.some((takvim) => takvim.id === secili || (secili === "primary" && takvim.primary))) {
    liste.unshift({ id: secili, primary: secili === "primary" });
  }
  return liste.length ? liste : [{ id: secili, primary: secili === "primary" }];
}

async function googleOlaylariCek(calendarId) {
  const bas = new Date();
  bas.setHours(0, 0, 0, 0);
  bas.setDate(bas.getDate() - 14);
  const bit = new Date();
  bit.setMonth(bit.getMonth() + 4);
  bit.setHours(23, 59, 59, 999);
  const olaylar = [];
  let pageToken = "";
  do {
    const params = new URLSearchParams({
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: "250",
      timeMin: bas.toISOString(),
      timeMax: bit.toISOString(),
    });
    if (pageToken) params.set("pageToken", pageToken);
    const data = await googleApi("/calendars/" + calendarId + "/events?" + params.toString());
    for (const olay of data.items || []) {
      if (!olay || olay.status === "cancelled" || !olay.id) continue;
      olaylar.push(olay);
    }
    pageToken = data.nextPageToken || "";
  } while (pageToken);
  return olaylar;
}

async function googleHatirlatmalariIceAktar(liste, calendarId, hamId) {
  let iceEklenen = 0;
  let iceGuncellenen = 0;
  const olaylar = await googleOlaylariCek(calendarId);
  const byGoogleId = new Map();
  const byVegaId = new Map();
  for (const item of liste) {
    if (item.googleEventId) byGoogleId.set(String(item.googleEventId), item);
    if (item.id) byVegaId.set(String(item.id), item);
  }
  for (const olay of olaylar) {
    // Doğum günü, konum ve Gmail’den gelenler not değil. Odak zamanı telefondan girilen nottur.
    const olayTip = String(olay.eventType || "default").toLowerCase();
    if (olayTip === "birthday" || olayTip === "workinglocation" || olayTip === "fromgmail") continue;
    const metinOn = String(olay.summary || "").trim();
    if (/doğum\s*günü|dogum\s*gunu|birthday/i.test(metinOn)) continue;
    const gunBoyu = Boolean(olay.start?.date && !olay.start?.dateTime);
    const vegaId = String(olay.extendedProperties?.private?.vegaId || "").trim();
    const zaman = googleOlayZamanParcala(olay);
    if (!zaman) continue;
    const metin = metinOn || String(olay.description || "").trim().split("\n")[0] || "Google olayı";
    const yer = String(olay.location || "").trim().slice(0, 120);
    if (!metin) continue;
    if (/^Vega Raporlama hatirlatmasi$/i.test(metin)) continue;
    let item = byGoogleId.get(String(olay.id));
    if (!item && vegaId) item = byVegaId.get(vegaId) || null;
    const googleGuncelleme = Date.parse(olay.updated || olay.created || "") || 0;
    if (item) {
      if (item.onceAnaId) continue;
      const yerelGuncelleme = Date.parse(item.guncelleme || item.olusturma || "") || 0;
      // Bağlı kayıtlarda yalnızca Google daha yeniyse yerel güncelle (çift yön).
      if (vegaId && googleGuncelleme && yerelGuncelleme && googleGuncelleme <= yerelGuncelleme + 2000) continue;
      const degisti =
        String(item.gun) !== zaman.gun
        || String(item.saat || "") !== zaman.saat
        || String(item.metin || "") !== metin.slice(0, 500);
      if (!degisti) {
        if (!item.googleEventId) item.googleEventId = olay.id;
        item.kaynak = item.kaynak || "google";
        if (yer) item.yer = yer;
        continue;
      }
      item.gun = zaman.gun;
      item.saat = zaman.saat;
      item.metin = metin.slice(0, 500);
      if (yer) item.yer = yer;
      else delete item.yer;
      item.googleEventId = olay.id;
      item.googleCalendarId = hamId || item.googleCalendarId || "";
      item.kaynak = item.kaynak || "google";
      item.googleGunBoyu = gunBoyu;
      if (olay.eventType) item.googleEventType = String(olay.eventType);
      if (olayTip && olayTip !== "default") item.googleSyncAtla = true;
      // Google’dan gelen/güncellenen notu tekrar aktif göster
      item.gonderildi = false;
      item.guncelleme = new Date(Math.max(googleGuncelleme, Date.now())).toISOString();
      try { await hatirlatmaGorevKur(item); } catch { /* görev sonra kurulur */ }
      iceGuncellenen += 1;
      continue;
    }
    // Yeni Google olayı → programa ekle
    item = {
      id: randomBytes(6).toString("hex"),
      gun: zaman.gun,
      saat: zaman.saat,
      metin: metin.slice(0, 500),
      yer: yer || undefined,
      gonderildi: false,
      olusturma: new Date().toISOString(),
      guncelleme: new Date(googleGuncelleme || Date.now()).toISOString(),
      googleEventId: olay.id,
      googleCalendarId: hamId || "",
      kaynak: "google",
      googleGunBoyu: gunBoyu,
      googleEventType: olay.eventType ? String(olay.eventType) : "default",
      googleSyncAtla: Boolean(olayTip && olayTip !== "default"),
      onceGun: 0,
    };
    liste.push(item);
    byGoogleId.set(String(olay.id), item);
    byVegaId.set(item.id, item);
    try { await hatirlatmaGorevKur(item); } catch { /* görev sonra kurulur */ }
    iceEklenen += 1;
  }
  return { iceEklenen, iceGuncellenen };
}

function odemeTakvimKapaliMi(durum) {
  const d = String(durum || "").toLocaleLowerCase("tr-TR");
  if (!d) return false;
  if (d.includes("tahsil") && !d.includes("bankada")) return true;
  if (d.includes("iptal") || d.includes("iade") || d.includes("protesto")) return true;
  return false;
}

function odemeTakvimMetin(kayit) {
  const turAd = { cek: "Çek", senet: "Senet", visa: "Visa" }[kayit.tur] || String(kayit.tur || "").toUpperCase();
  const yonAd = kayit.yon === "odeme" ? "Ödeme" : "Tahsilat";
  const tutar = Number(kayit.tutar || 0).toLocaleString("tr-TR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " ₺";
  const parcalar = [turAd + " " + yonAd, kayit.firma, kayit.belge, tutar].filter(Boolean);
  if (kayit.takas) parcalar.push("Takas");
  return parcalar.join(" · ").slice(0, 500);
}

function odemeTakvimAnahtar(kayit) {
  return createHash("sha1")
    .update([kayit.tur, kayit.yon, kayit.gun, kayit.belge, kayit.firma, String(Number(kayit.tutar) || 0)].join("|"), "utf8")
    .digest("hex")
    .slice(0, 20);
}

async function odemeTakvimKayitlariGetir(firma, donem, basGun, bitGun, ciroDahil = false) {
  const firmaNo = tamSayi(firma);
  const donemNo = tamSayi(donem);
  if (!firmaNo || !donemNo) return [];
  const bas = `CONVERT(datetime, N'${String(basGun).slice(8, 10)}.${String(basGun).slice(5, 7)}.${String(basGun).slice(0, 4)}', 104)`;
  const bit = `DATEADD(day, 1, CONVERT(datetime, N'${String(bitGun).slice(8, 10)}.${String(bitGun).slice(5, 7)}.${String(bitGun).slice(0, 4)}', 104))`;
  const temiz = (ifade) => `REPLACE(REPLACE(REPLACE(RTRIM(ISNULL(CAST(${ifade} AS nvarchar(200)), N'')), N'|', N'/'), CHAR(13), N' '), CHAR(10), N' ')`;
  const kaynaklar = [
    { tur: "cek", yon: "tahsilat", view: "VARESALINANCEKLER", islem: "CEKISLEM" },
    { tur: "cek", yon: "odeme", view: "VARESVERILENCEKLER", islem: "VCEKISLEM" },
    { tur: "senet", yon: "tahsilat", view: "VARESALINANSENETLER", islem: "SENETISLEM" },
    { tur: "senet", yon: "odeme", view: "VARESVERILENSENETLER", islem: "VSENETISLEM" },
    { tur: "visa", yon: "tahsilat", view: "VARESALINANKREDIKARTI", islem: "KARTISLEM" },
  ];
  const kayitlar = [];
  await Promise.all(kaynaklar.map(async (kaynak) => {
    const view = await nesneVar(donemTablo(firmaNo, donemNo, kaynak.view));
    if (!view) return;
    const kolon = await kolonKumesi(view);
    if (!kolon.has("VADE") && !kolon.has("TARIH")) return;
    const tarihAlan = kolon.has("VADE") ? "VADE" : "TARIH";
    const kosul = [`k.${tarihAlan} >= ${bas}`, `k.${tarihAlan} < ${bit}`];
    if (!ciroDahil && kaynak.tur === "cek") {
      const ciroParca = [];
      if (kaynak.islem && kolon.has(kaynak.islem)) {
        ciroParca.push(`RTRIM(ISNULL(k.${kaynak.islem}, N'')) NOT LIKE N'%Ciro%'`);
      }
      if (kolon.has("CIROEDILENFIRMAADI")) {
        ciroParca.push(`RTRIM(ISNULL(k.CIROEDILENFIRMAADI, N'')) = N''`);
      }
      if (ciroParca.length) kosul.push("(" + ciroParca.join(" AND ") + ")");
    }
    const islemAlan = kaynak.islem && kolon.has(kaynak.islem) ? kaynak.islem : "";
    if (islemAlan) {
      kosul.push(`NOT (
        LOWER(RTRIM(ISNULL(k.${islemAlan}, N''))) LIKE N'%tahsil%'
        AND LOWER(RTRIM(ISNULL(k.${islemAlan}, N''))) NOT LIKE N'%bankada%'
      )`);
      kosul.push(`LOWER(RTRIM(ISNULL(k.${islemAlan}, N''))) NOT LIKE N'%iptal%'`);
      kosul.push(`LOWER(RTRIM(ISNULL(k.${islemAlan}, N''))) NOT LIKE N'%iade%'`);
      kosul.push(`LOWER(RTRIM(ISNULL(k.${islemAlan}, N''))) NOT LIKE N'%protesto%'`);
    }
    const lines = await queryLines(`
SET NOCOUNT ON;
SELECT
  CONVERT(varchar(10), k.${tarihAlan}, 23),
  ${kolon.has("FIRMAADI") ? temiz("k.FIRMAADI") : "N''"},
  ${kolon.has("KESIDEEDEN") ? temiz("k.KESIDEEDEN") : "N''"},
  ${kolon.has("BELGENO") ? temiz("k.BELGENO") : "N''"},
  ${kolon.has("TUTAR") ? "CAST(ISNULL(k.TUTAR, 0) AS decimal(18, 2))" : "CAST(0 AS decimal(18, 2))"},
  ${islemAlan ? temiz(`k.${islemAlan}`) : "N''"}
FROM ${view} k
WHERE ${kosul.join(" AND ")}
ORDER BY k.${tarihAlan};
`);
    for (const line of lines) {
      const [gun, firmaAd, keside, belge, tutar, durum] = line.split("|").map((part) => part.trim());
      if (!gun || gun.toUpperCase() === "NULL") continue;
      const durumYazi = durum || "";
      if (odemeTakvimKapaliMi(durumYazi)) continue;
      const kim = firmaAd || keside || "—";
      kayitlar.push({
        gun,
        tur: kaynak.tur,
        yon: kaynak.yon,
        firma: kim,
        keside: keside && keside !== kim ? keside : "",
        belge,
        tutar: Number(tutar) || 0,
        durum: durumYazi,
        takas: kaynak.tur === "cek" && /takas/i.test(durumYazi),
      });
    }
  }));
  return kayitlar;
}

async function odemeTakvimHatirlatmalariSenkronize(liste, firma, donem) {
  const bugun = new Date();
  const bas = new Date(bugun.getFullYear(), bugun.getMonth(), bugun.getDate() - 7);
  const bit = new Date(bugun.getFullYear(), bugun.getMonth() + 4, bugun.getDate());
  const kod = (d) => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  const kayitlar = await odemeTakvimKayitlariGetir(firma, donem, kod(bas), kod(bit), false);
  const byKey = new Map();
  for (const item of liste) {
    if (item.odemeKey) byKey.set(String(item.odemeKey), item);
  }
  const aktif = new Set();
  let eklenen = 0;
  let guncellenen = 0;
  for (const kayit of kayitlar) {
    const odemeKey = odemeTakvimAnahtar(kayit);
    aktif.add(odemeKey);
    const metin = odemeTakvimMetin(kayit);
    let item = byKey.get(odemeKey);
    if (item) {
      const degisti =
        String(item.gun) !== kayit.gun
        || String(item.metin || "") !== metin
        || item.gonderildi === true;
      item.kaynak = "odeme-takvim";
      item.odemeKey = odemeKey;
      item.saat = item.saat || "09:00";
      item.onceGun = Math.min(30, Math.max(0, Number(item.onceGun) || 0));
      if (!degisti) continue;
      item.gun = kayit.gun;
      item.metin = metin;
      item.gonderildi = false;
      item.guncelleme = new Date().toISOString();
      guncellenen += 1;
      continue;
    }
    item = {
      id: randomBytes(6).toString("hex"),
      gun: kayit.gun,
      saat: "09:00",
      metin,
      gonderildi: false,
      olusturma: new Date().toISOString(),
      guncelleme: new Date().toISOString(),
      kaynak: "odeme-takvim",
      odemeKey,
      onceGun: 0,
    };
    liste.push(item);
    byKey.set(odemeKey, item);
    eklenen += 1;
  }
  let kapanan = 0;
  for (const item of liste) {
    if (item.kaynak !== "odeme-takvim" || !item.odemeKey) continue;
    if (aktif.has(String(item.odemeKey))) continue;
    if (item.gonderildi) continue;
    item.gonderildi = true;
    item.guncelleme = new Date().toISOString();
    kapanan += 1;
  }
  return { eklenen, guncellenen, kapanan, toplam: aktif.size };
}

function teklifBaglamlari() {
  const liste = [];
  const gorulen = new Set();
  const ekle = (firma, donem) => {
    const firmaNo = tamSayi(firma);
    const donemNo = tamSayi(donem);
    if (!firmaNo || !donemNo) return;
    const anahtar = firmaNo + ":" + donemNo;
    if (gorulen.has(anahtar)) return;
    gorulen.add(anahtar);
    liste.push({ firma: firmaNo, donem: donemNo });
  };
  for (const oturumKaydi of oturumlar.values()) ekle(oturumKaydi?.firma, oturumKaydi?.donem);
  const kayitli = googleBaglamOku();
  ekle(kayitli.firma, kayitli.donem);
  return liste;
}

function teklifMetin(kayit) {
  const [yil, ay, gun] = String(kayit.tarih || "").split("-");
  const tarih = gun && ay && yil ? gun + "." + ay + "." + yil : "";
  return [kayit.cari, tarih, kayit.belge].filter(Boolean).join(" · ").slice(0, 500);
}

async function teklifKayitlariGetir(firma, donem) {
  const firmaNo = tamSayi(firma);
  const donemNo = tamSayi(donem);
  if (!firmaNo || !donemNo) return [];
  const tablo = donemTablo(firmaNo, donemNo, "TBLPROFATBASLIK");
  if (!await nesneVar(tablo)) return [];
  const cari = firmaTablo(firmaNo, "TBLCARI");
  const cariVar = await nesneVar(cari);
  const temiz = (ifade) => `REPLACE(REPLACE(REPLACE(RTRIM(ISNULL(CAST(${ifade} AS nvarchar(200)), N'')), N'|', N'/'), CHAR(13), N' '), CHAR(10), N' ')`;
  const cariAd = cariVar
    ? `COALESCE(NULLIF(${temiz("b.FIRMAADI")}, N''), ${temiz("c.FIRMAADI")})`
    : temiz("b.FIRMAADI");
  const lines = await queryLines(`
SET NOCOUNT ON;
SELECT
  CAST(b.IND AS varchar(12)),
  CONVERT(varchar(10), b.TARIH, 23),
  ${cariAd},
  ${temiz("b.BELGENO")},
  CASE WHEN ISNULL(b.IPTAL, 0) = 1 THEN N'1' ELSE N'0' END
FROM ${tablo} b
${cariVar ? `LEFT JOIN ${cari} c ON c.IND = b.FIRMANO` : ""}
WHERE ISNULL(b.BELGETIPI, 0) = 120
  AND b.TARIH >= DATEADD(day, -30, CAST(GETDATE() AS date))
  AND b.TARIH < DATEADD(day, 1, CAST(GETDATE() AS date));
`);
  const kayitlar = [];
  for (const line of lines) {
    const [ind, tarih, cari, belge, iptal] = line.split("|").map((part) => part.trim());
    if (!ind || !/^\d{4}-\d{2}-\d{2}$/.test(tarih || "")) continue;
    kayitlar.push({
      ind,
      tarih,
      cari: cari || "—",
      belge: belge || "—",
      iptal: iptal === "1",
    });
  }
  return kayitlar;
}

async function teklifHatirlatmalariSenkronize(liste, firma, donem) {
  const kayitlar = await teklifKayitlariGetir(firma, donem);
  const byKey = new Map();
  for (const item of liste) {
    if (item.teklifKey) byKey.set(String(item.teklifKey), item);
  }
  let eklenen = 0;
  let guncellenen = 0;
  let kapanan = 0;
  for (const kayit of kayitlar) {
    const teklifKey = "teklif:" + tamSayi(firma) + ":" + tamSayi(donem) + ":" + kayit.ind;
    const gun = hatirlatmaGunKaydir(kayit.tarih, 7);
    const saat = "10:00";
    const metin = teklifMetin(kayit);
    const zaman = new Date(gun + "T" + saat + ":00");
    let item = byKey.get(teklifKey);
    if (kayit.iptal) {
      if (item && !item.gonderildi) {
        item.gonderildi = true;
        item.guncelleme = new Date().toISOString();
        kapanan += 1;
        try { await hatirlatmaGorevSil(item.id); } catch { /* görev kalkar */ }
      }
      continue;
    }
    if (!item && (!Number.isFinite(zaman.getTime()) || zaman.getTime() < Date.now() - 12 * 60 * 60 * 1000)) continue;
    if (item) {
      const degisti = String(item.gun) !== gun || String(item.saat) !== saat || String(item.metin || "") !== metin || item.gonderildi === true;
      item.kaynak = "teklif";
      item.teklifKey = teklifKey;
      item.saat = saat;
      if (!degisti) continue;
      item.gun = gun;
      item.metin = metin;
      item.gonderildi = false;
      item.guncelleme = new Date().toISOString();
      guncellenen += 1;
      try { await hatirlatmaGorevKur(item); } catch { /* görev sonra kurulur */ }
      continue;
    }
    item = {
      id: randomBytes(6).toString("hex"),
      gun,
      saat,
      metin,
      gonderildi: false,
      olusturma: new Date().toISOString(),
      guncelleme: new Date().toISOString(),
      kaynak: "teklif",
      teklifKey,
      onceGun: 0,
    };
    liste.push(item);
    byKey.set(teklifKey, item);
    eklenen += 1;
    try { await hatirlatmaGorevKur(item); } catch { /* görev sonra kurulur */ }
  }
  return { eklenen, guncellenen, kapanan };
}

let teklifSonCalisma = 0;
let teklifIs = null;

async function teklifHatirlatmaOtomatik(zorla = false) {
  if (teklifIs) return teklifIs;
  if (!zorla && Date.now() - teklifSonCalisma < 60 * 1000) return null;
  const is = (async () => {
    const baglamlar = teklifBaglamlari();
    if (!baglamlar.length) return { eklenen: 0, guncellenen: 0, kapanan: 0 };
    const liste = hatirlatmalariOku();
    let eklenen = 0;
    let guncellenen = 0;
    let kapanan = 0;
    for (const baglam of baglamlar) {
      const sonuc = await teklifHatirlatmalariSenkronize(liste, baglam.firma, baglam.donem);
      eklenen += sonuc.eklenen;
      guncellenen += sonuc.guncellenen;
      kapanan += sonuc.kapanan;
    }
    if (eklenen || guncellenen || kapanan) hatirlatmalariYaz(liste);
    teklifSonCalisma = Date.now();
    return { eklenen, guncellenen, kapanan };
  })();
  teklifIs = is;
  is.finally(() => {
    if (teklifIs === is) teklifIs = null;
  });
  return is;
}

async function googleHatirlatmalariSenkronize(baglam = {}) {
  const ayar = googleAyarOku();
  const calendarId = encodeURIComponent(ayar.calendarId || "primary");
  // Önce API erişimini doğrula
  try {
    await googleApi("/calendars/" + calendarId);
  } catch (error) {
    const msg = String(error.message || "");
    if (/insufficient|PERMISSION_DENIED|Insufficient/i.test(msg)) {
      throw new Error(
        "Takvim izni yok. Google panelinde Bağlantıyı kes → Google ile bağla deyip Takvim iznini onaylayın. "
        + "Cloud Console’da Google Calendar API açık olmalı."
      );
    }
    if (/not been used|disabled|has not been used/i.test(msg) || error.status === 403) {
      throw new Error(
        "Google Calendar API kapalı veya yetkisiz. Cloud Console → API’ler → \"Google Calendar API\" etkinleştirin. "
        + "Ardından tekrar bağlanıp senkronize edin. (" + msg + ")"
      );
    }
    throw error;
  }
  const liste = hatirlatmalariOku();
  let odemeEklenen = 0;
  let odemeGuncellenen = 0;
  let odemeKapanan = 0;
  let odemeHata = "";
  let firma = tamSayi(baglam.firma);
  let donem = tamSayi(baglam.donem);
  if (!firma || !donem) {
    for (const o of oturumlar.values()) {
      if (o?.firma && o?.donem) {
        firma = tamSayi(o.firma);
        donem = tamSayi(o.donem);
        break;
      }
    }
  }
  if ((!firma || !donem)) {
    const kayitli = googleBaglamOku();
    firma = firma || kayitli.firma;
    donem = donem || kayitli.donem;
  }
  if (firma && donem) {
    googleBaglamYaz({ firma, donem });
    try {
      const odeme = await odemeTakvimHatirlatmalariSenkronize(liste, firma, donem);
      odemeEklenen = odeme.eklenen;
      odemeGuncellenen = odeme.guncellenen;
      odemeKapanan = odeme.kapanan;
    } catch (error) {
      odemeHata = error.message || "Ödeme takvimi okunamadı";
    }
    try {
      await teklifHatirlatmalariSenkronize(liste, firma, donem);
    } catch { /* teklif hatırlatması takvimi durdurmasın */ }
  }
  let iceEklenen = 0;
  let iceGuncellenen = 0;
  let iceHata = "";
  try {
    const takvimler = await googleYazilabilirTakvimler();
    for (const takvim of takvimler) {
      const ice = await googleHatirlatmalariIceAktar(liste, encodeURIComponent(takvim.id), takvim.id);
      iceEklenen += ice.iceEklenen;
      iceGuncellenen += ice.iceGuncellenen;
    }
  } catch (error) {
    iceHata = error.message || "Google’dan okuma hatası";
  }
  // Google Görevler (Tasks) — Takvim olayından ayrı API
  let gorevIceEklenen = 0;
  let gorevIceGuncellenen = 0;
  let gorevIceHata = "";
  try {
    const gorevIce = await googleGorevleriIceAktar(liste);
    gorevIceEklenen = gorevIce.iceEklenen;
    gorevIceGuncellenen = gorevIce.iceGuncellenen;
    iceEklenen += gorevIceEklenen;
    iceGuncellenen += gorevIceGuncellenen;
  } catch (error) {
    const msg = String(error.message || "");
    if (/blocked|has not been used|accessNotConfigured|disabled/i.test(msg)) {
      gorevIceHata = "Tasks API kapalı. Cloud Console → API’ler → \"Google Tasks API\" etkinleştirin, birkaç dakika bekleyip tekrar senkronize edin.";
    } else if (/insufficient|PERMISSION_DENIED|ACCESS_TOKEN_SCOPE|auth|scope/i.test(msg) || error.status === 401 || error.status === 403) {
      gorevIceHata = "Görev izni yok. Google → Bağlantıyı kes → Google ile bağla (Tasks iznini onaylayın).";
    } else {
      gorevIceHata = msg || "Görev okuma hatası";
    }
  }
  let eklenen = 0;
  let guncellenen = 0;
  let silinen = 0;
  let hata = 0;
  const hatalar = [];
  const sonZaman = Date.parse(googleSonSenkronOku()?.zaman || "") || 0;
  for (const item of liste) {
    try {
      const hedefTakvim = encodeURIComponent(item.googleCalendarId || ayar.calendarId || "primary");
      if (item.gonderildi) {
        // Google’dan gelen olayları yerel uyarı kapatılınca Takvim’den silme
        if (item.googleEventId && item.kaynak !== "google") {
          try {
            await googleApi("/calendars/" + hedefTakvim + "/events/" + encodeURIComponent(item.googleEventId), { method: "DELETE" });
            silinen += 1;
          } catch { /* zaten yok */ }
          delete item.googleEventId;
        }
        continue;
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(item.gun || ""))) {
        throw new Error("Gecersiz tarih: " + item.gun);
      }
      // Daha önce içe aktarılmış doğum günü vb. Google’a geri yazma
      if (googleOzelOlayMi(item, null)) {
        item.googleSyncAtla = true;
        continue;
      }
      const govde = googleOlayGovde(item);
      const imza = googleIcerikImza(govde);
      if (!googleYazmaGerekli(item, imza, "googleEventId", "googleImza", sonZaman)) continue;
      if (item.googleEventId) {
        try {
          // PATCH: özel eventType alanını bozmadan yalnızca bizim alanları güncelle
          await googleApi("/calendars/" + hedefTakvim + "/events/" + encodeURIComponent(item.googleEventId), {
            method: "PATCH",
            body: JSON.stringify(govde),
          });
          item.googleImza = imza;
          guncellenen += 1;
        } catch (error) {
          const msg = String(error.message || "");
          // Doğum günü / tüm gün / geçersiz başlangıç — atla
          if (/Event type cannot be changed|eventType|Invalid start time|Invalid end time|start time/i.test(msg)) {
            item.googleSyncAtla = true;
            continue;
          }
          // Eski olay silinmişse yeniden oluştur
          if (error.status === 404 || /Not Found/i.test(msg)) {
            delete item.googleEventId;
            const olusan = await googleApi("/calendars/" + hedefTakvim + "/events", {
              method: "POST",
              body: JSON.stringify(govde),
            });
            item.googleEventId = olusan.id;
            item.googleImza = imza;
            eklenen += 1;
          } else throw error;
        }
      } else {
        const olusan = await googleApi("/calendars/" + hedefTakvim + "/events", {
          method: "POST",
          body: JSON.stringify(govde),
        });
        item.googleEventId = olusan.id;
        item.googleImza = imza;
        eklenen += 1;
      }
    } catch (error) {
      hata += 1;
      if (hatalar.length < 5) {
        hatalar.push((item.gun || "?") + ": " + (error.message || "bilinmeyen hata"));
      }
    }
  }
  // Programa yazılanları Google Görevler’e de yaz (çift yön)
  let gorevEklenen = 0;
  let gorevGuncellenen = 0;
  try {
    const gorevDis = await googleGorevleriDisaAktar(liste);
    gorevEklenen = gorevDis.eklenen;
    gorevGuncellenen = gorevDis.guncellenen;
    eklenen += gorevEklenen;
    guncellenen += gorevGuncellenen;
    hata += gorevDis.hata || 0;
    for (const x of gorevDis.hatalar || []) {
      if (hatalar.length < 5) hatalar.push(x);
    }
  } catch (error) {
    if (!gorevIceHata) gorevIceHata = error.message || "Görev yazma hatası";
  }
  hatirlatmalariYaz(liste);
  return {
    eklenen,
    guncellenen,
    silinen,
    iceEklenen,
    iceGuncellenen,
    iceHata: [iceHata, gorevIceHata, odemeHata].filter(Boolean).join(" · "),
    gorevIceEklenen,
    gorevIceGuncellenen,
    gorevEklenen,
    gorevGuncellenen,
    odemeEklenen,
    odemeGuncellenen,
    odemeKapanan,
    hata,
    hatalar,
    toplam: liste.filter((x) => !x.gonderildi).length,
  };
}

const wa = {
  sock: null,
  durum: "kapali",
  qr: "",
  ad: "",
  telefon: "",
  hata: "",
  kapanis: false,
  baslatma: null,
  rehber: new Map(),
};

function whatsappDurum() {
  return {
    hazir: wa.durum === "bagli",
    durum: wa.durum,
    qr: wa.durum === "qr" ? wa.qr : "",
    ad: wa.ad,
    telefon: wa.telefon,
    hata: wa.hata,
  };
}

function telefonNorm(value) {
  let rakam = String(value || "").replace(/\D/g, "");
  if (rakam.startsWith("00")) rakam = rakam.slice(2);
  if (rakam.startsWith("0")) rakam = "90" + rakam.slice(1);
  if (rakam.length === 10) rakam = "90" + rakam;
  return rakam;
}

function telefonKayitlari(value) {
  return String(value || "").split(/[;/,|]/).map((parca) => parca.trim()).filter(Boolean).flatMap((parca) => {
    const metin = parca.replace(/-(\d{2,5})\s*$/, (ek, _no, offset, kaynak) => {
      const sol = String(kaynak || "").slice(0, offset).replace(/\D/g, "");
      return sol.length >= 7 ? "" : ek;
    });
    const eslesme = metin.match(/^([+0-9().\s_-]*\d)\s*(.*)$/);
    if (!eslesme) return [];
    const telefon = telefonNorm(eslesme[1]);
    const ad = String(eslesme[2] || "").replace(/^[\s._:-]+/, "").replace(/[\s._:-]+$/, "").trim();
    if (telefon.length < 12 || telefon.length > 15) return [];
    return [{ telefon, ad }];
  });
}

function cariTelefonKisileri(deger) {
  const firmaAd = deger.FIRMAADI || "";
  const yetkili = deger.YETKILI || [deger.ADI, deger.SOYADI].filter(Boolean).join(" ") || firmaAd;
  const kefil1 = deger.KEFIL1 || "Kefil 1";
  const kefil2 = deger.KEFIL2 || "Kefil 2";
  const kaynak = [
    ["YGSM", "yetkili", yetkili, "Cep"],
    ["YTELEFON1", "yetkili", yetkili, "Telefon"],
    ["YTELEFON2", "yetkili", yetkili, "Telefon 2"],
    ["TELEFON1", "firma", firmaAd, "Telefon 1"],
    ["TELEFON2", "firma", firmaAd, "Telefon 2"],
    ["TELEFON3", "firma", firmaAd, "Telefon 3"],
    ["KEFIL1CEPTELEFON", "kefil", kefil1, "Cep"],
    ["KEFIL1TELEFON", "kefil", kefil1, "Telefon"],
    ["KEFIL2CEPTELEFON", "kefil", kefil2, "Cep"],
    ["KEFIL2TELEFON", "kefil", kefil2, "Telefon"],
  ];
  const gorulen = new Set();
  const kisiler = [];
  let dolu = 0;
  for (const [alan, tur, ad, etiket] of kaynak) {
    const ham = String(deger[alan] || "").trim();
    if (!ham) continue;
    const adaylar = telefonKayitlari(ham);
    if (!adaylar.length) {
      dolu += 1;
      continue;
    }
    adaylar.forEach((kayit, index) => {
      dolu += 1;
      if (gorulen.has(kayit.telefon)) return;
      gorulen.add(kayit.telefon);
      const sira = adaylar.length > 1 ? " " + (index + 1) : "";
      kisiler.push({ ad: "", firma: firmaAd, etiket: etiket + sira, telefon: kayit.telefon });
    });
  }
  return { kisiler, dolu };
}

function paketGirisi(ad) {
  const parca = String(ad).split("/").filter(Boolean);
  const kokler = [
    join(dirname(process.execPath), "node_modules"),
    join(process.cwd(), "node_modules"),
    join(__dirname, "node_modules"),
  ];
  const gorulen = new Set();
  for (const kok of kokler) {
    const anahtar = kok.toLowerCase();
    if (gorulen.has(anahtar)) continue;
    gorulen.add(anahtar);
    const klasor = join(kok, ...parca);
    const paketJson = join(klasor, "package.json");
    if (!existsSync(paketJson)) continue;
    let giris = "index.js";
    try {
      const pkg = JSON.parse(readFileSync(paketJson, "utf8"));
      if (typeof pkg.main === "string" && pkg.main.trim()) giris = pkg.main.trim();
    } catch { /* package.json okunamadı */ }
    const dosya = join(klasor, giris);
    if (existsSync(dosya)) return pathToFileURL(dosya).href;
  }
  return "";
}

async function disPaket(ad) {
  try {
    return await import(ad);
  } catch (ilk) {
    const url = paketGirisi(ad);
    if (!url) throw ilk;
    return import(url);
  }
}

function whatsappRehberDosya() {
  return join(whatsappKlasor(), "rehber.json");
}

function whatsappRehberYukle() {
  if (wa.rehber.size) return;
  try {
    if (!existsSync(whatsappRehberDosya())) return;
    const veri = JSON.parse(readFileSync(whatsappRehberDosya(), "utf8"));
    for (const [telefon, kayit] of Object.entries(veri || {})) {
      const no = telefonNorm(telefon);
      if (no.length < 12 || !kayit || typeof kayit !== "object") continue;
      const rehber = String(kayit.rehber || "").trim();
      const profil = String(kayit.profil || "").trim();
      if (rehber || profil) wa.rehber.set(no, { rehber, profil });
    }
  } catch { /* rehber okunamadı */ }
}

let waRehberKayit;
function whatsappRehberKaydet() {
  clearTimeout(waRehberKayit);
  waRehberKayit = setTimeout(() => {
    try {
      mkdirSync(whatsappKlasor(), { recursive: true });
      const nesne = {};
      for (const [no, kayit] of wa.rehber) nesne[no] = kayit;
      writeFileSync(whatsappRehberDosya(), JSON.stringify(nesne));
    } catch { /* rehber yazılamadı */ }
  }, 400);
}

function whatsappKisiTelefon(kisi) {
  const kaynak = kisi?.phoneNumber || kisi?.id || "";
  return telefonNorm(String(kaynak).split("@")[0].split(":")[0]);
}

function whatsappAdTemiz(value) {
  const ad = String(value || "").replace(/\s+/g, " ").trim();
  if (!ad || ad.length > 80 || /^[+\d\s()._-]+$/.test(ad)) return "";
  return ad;
}

function whatsappRehberYaz(telefon, parca) {
  const no = telefonNorm(telefon);
  if (no.length < 12 || no.length > 15) return false;
  const once = wa.rehber.get(no) || { rehber: "", profil: "" };
  const sonra = {
    rehber: whatsappAdTemiz(parca.rehber) || once.rehber,
    profil: whatsappAdTemiz(parca.profil) || once.profil,
  };
  if (sonra.rehber === once.rehber && sonra.profil === once.profil) return false;
  wa.rehber.set(no, sonra);
  return true;
}

function whatsappRehberDinle(sock) {
  sock.ev.on("contacts.upsert", (liste) => {
    let degisti = false;
    for (const kisi of liste || []) {
      if (whatsappRehberYaz(whatsappKisiTelefon(kisi), { rehber: kisi?.name, profil: kisi?.notify || kisi?.verifiedName })) degisti = true;
    }
    if (degisti) whatsappRehberKaydet();
  });
  sock.ev.on("contacts.update", (liste) => {
    let degisti = false;
    for (const kisi of liste || []) {
      if (whatsappRehberYaz(whatsappKisiTelefon(kisi), { profil: kisi?.notify || kisi?.verifiedName })) degisti = true;
    }
    if (degisti) whatsappRehberKaydet();
  });
  sock.ev.on("messaging-history.set", (gecmis) => {
    let degisti = false;
    for (const kisi of gecmis?.contacts || []) {
      if (whatsappRehberYaz(whatsappKisiTelefon(kisi), { rehber: kisi?.name, profil: kisi?.notify || kisi?.verifiedName })) degisti = true;
    }
    if (degisti) whatsappRehberKaydet();
  });
}

function whatsappDugumAd(node, derinlik = 0) {
  if (!node || derinlik > 8) return "";
  const attrs = node.attrs || {};
  const attrAd = whatsappAdTemiz(attrs.notify || attrs.pushname || attrs.name || attrs.verified_name || attrs.short);
  if (attrAd && attrs.type !== "in" && attrs.type !== "out") return attrAd;
  const icerik = node.content;
  if (typeof icerik === "string") return node.tag === "contact" ? "" : whatsappAdTemiz(icerik);
  if (Buffer.isBuffer(icerik)) return node.tag === "contact" ? "" : whatsappAdTemiz(icerik.toString("utf8"));
  if (Array.isArray(icerik)) {
    for (const cocuk of icerik) {
      const ad = whatsappDugumAd(cocuk, derinlik + 1);
      if (ad) return ad;
    }
  }
  return "";
}

async function whatsappProfilSorgula(telefon) {
  const sock = wa.sock;
  if (!sock?.query || wa.durum !== "bagli") return "";
  const no = telefonNorm(telefon);
  try {
    const sonuc = await sock.query({
      tag: "iq",
      attrs: { to: "s.whatsapp.net", type: "get", xmlns: "usync" },
      content: [{
        tag: "usync",
        attrs: { context: "interactive", mode: "query", sid: String(Date.now()), last: "true", index: "0" },
        content: [
          { tag: "query", attrs: {}, content: [{ tag: "contact", attrs: {} }, { tag: "status", attrs: {} }] },
          { tag: "list", attrs: {}, content: [{ tag: "user", attrs: {}, content: [{ tag: "contact", attrs: {}, content: "+" + no }] }] },
        ],
      }],
    });
    return whatsappDugumAd(sonuc);
  } catch {
    return "";
  }
}

let waRehberIs = null;
let waRehberTam = false;
async function whatsappRehberHazir(telefonlar) {
  whatsappRehberYukle();
  const nolar = [...new Set((telefonlar || []).map(telefonNorm).filter((no) => no.length >= 12 && no.length <= 15))];
  if (wa.durum === "bagli" && wa.sock?.resyncAppState && !waRehberTam) {
    if (!waRehberIs) {
      waRehberIs = (async () => {
        try {
          try { unlinkSync(join(whatsappKlasor(), "app-state-sync-version-critical_unblock_low.json")); } catch { /* sürüm dosyası yok */ }
          await wa.sock.resyncAppState(["critical_unblock_low"], true);
        } catch { /* rehber senkronu tamamlanamadı */ }
      })().finally(() => { waRehberIs = null; waRehberTam = true; });
    }
    await Promise.race([waRehberIs, new Promise((resolve) => setTimeout(resolve, 12000))]);
  }
  for (const no of nolar) {
    const kayit = wa.rehber.get(no);
    if (kayit?.rehber || kayit?.profil) continue;
    const profil = await whatsappProfilSorgula(no);
    if (profil && whatsappRehberYaz(no, { profil })) whatsappRehberKaydet();
  }
}

function whatsappGorunenAd(telefon) {
  const kayit = wa.rehber.get(telefonNorm(telefon));
  if (!kayit) return { ad: "", kaynak: "" };
  if (kayit.rehber) return { ad: kayit.rehber, kaynak: "rehber" };
  if (kayit.profil) return { ad: kayit.profil, kaynak: "whatsapp" };
  return { ad: "", kaynak: "" };
}

async function whatsappAc() {
  const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    Browsers,
  } = await disPaket("@whiskeysockets/baileys");
  const pino = (await disPaket("pino")).default;
  const qrcode = await disPaket("qrcode");
  const toDataURL = qrcode.toDataURL || qrcode.default.toDataURL;
  const klasor = whatsappKlasor();
  mkdirSync(klasor, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(klasor);
  wa.durum = "baglaniyor";
  wa.hata = "";
  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: "silent" }),
    browser: Browsers.windows("Vega Raporlama"),
    syncFullHistory: false,
    markOnlineOnConnect: false,
  });
  wa.sock = sock;
  whatsappRehberDinle(sock);
  sock.ev.on("creds.update", saveCreds);
  sock.ev.on("connection.update", (update) => {
    if (update.qr) {
      toDataURL(update.qr, { margin: 1, width: 280 }).then((adres) => {
        if (wa.sock !== sock) return;
        wa.qr = adres;
        wa.durum = "qr";
      }).catch((error) => {
        wa.hata = error.message || "QR oluşturulamadı.";
      });
    }
    if (update.connection === "open") {
      wa.durum = "bagli";
      wa.qr = "";
      wa.hata = "";
      const kullanici = sock.user || {};
      const telefon = String(kullanici.id || "").split(":")[0].split("@")[0].replace(/\D/g, "");
      wa.telefon = telefon;
      wa.ad = String(kullanici.name || telefon || "");
    }
    if (update.connection === "close") {
      const kod = update.lastDisconnect?.error?.output?.statusCode;
      if (wa.sock === sock) wa.sock = null;
      wa.qr = "";
      const cikis = wa.kapanis || kod === DisconnectReason.loggedOut || kod === DisconnectReason.forbidden;
      if (cikis) {
        wa.durum = "kapali";
        wa.ad = "";
        wa.telefon = "";
        if (kod === DisconnectReason.loggedOut || kod === DisconnectReason.forbidden) {
          wa.hata = "Telefon bağlantısı kapandı. Yeniden QR okutun.";
          try { rmSync(klasor, { recursive: true, force: true }); } catch { /* oturum silinemedi */ }
        }
        return;
      }
      wa.durum = "baglaniyor";
      setTimeout(() => {
        if (wa.kapanis || wa.sock) return;
        whatsappAc().catch((error) => {
          wa.durum = "hata";
          wa.hata = error.message || "WhatsApp bağlantısı kurulamadı.";
        });
      }, 2000);
    }
  });
}

async function whatsappBagla() {
  if (wa.sock && (wa.durum === "bagli" || wa.durum === "qr" || wa.durum === "baglaniyor")) {
    return whatsappDurum();
  }
  if (wa.baslatma) {
    await wa.baslatma;
    return whatsappDurum();
  }
  wa.kapanis = false;
  wa.baslatma = whatsappAc().finally(() => { wa.baslatma = null; });
  await wa.baslatma;
  return whatsappDurum();
}

async function whatsappCikis() {
  wa.kapanis = true;
  const sock = wa.sock;
  wa.sock = null;
  wa.qr = "";
  wa.ad = "";
  wa.telefon = "";
  wa.hata = "";
  wa.durum = "kapali";
  wa.rehber.clear();
  try { await sock?.logout(); } catch { /* oturum zaten kapalı */ }
  try { rmSync(whatsappKlasor(), { recursive: true, force: true }); } catch { /* oturum silinemedi */ }
  return whatsappDurum();
}

function edgeBul() {
  const pf = process.env.ProgramFiles || "C:\\Program Files";
  const pf86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const local = process.env.LOCALAPPDATA || "";
  // Chrome öncelikli: --app penceresi Windows uygulaması gibi açılır.
  return ilkVarolan([
    join(pf, "Google", "Chrome", "Application", "chrome.exe"),
    join(pf86, "Google", "Chrome", "Application", "chrome.exe"),
    join(local, "Google", "Chrome", "Application", "chrome.exe"),
    join(pf, "Microsoft", "Edge", "Application", "msedge.exe"),
    join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"),
    join(local, "Microsoft", "Edge", "Application", "msedge.exe"),
  ]);
}

function paketMi() {
  try { return require("node:sea").isSea(); } catch { return false; }
}

function ikonYolu() {
  return ilkVarolan([
    join(__dirname, "assets", "expert-bilisim.ico"),
    join(dirname(process.execPath), "expert-bilisim.ico"),
  ]);
}

function pngYolu() {
  return ilkVarolan([
    join(__dirname, "assets", "expert-bilisim.png"),
    join(dirname(process.execPath), "expert-bilisim.png"),
  ]);
}

function surumParcala(surum) {
  return String(surum || "")
    .replace(/^v/i, "")
    .split(/[^\d]+/)
    .filter(Boolean)
    .map((x) => Number(x) || 0);
}

function surumKarsilastir(a, b) {
  const x = surumParcala(a);
  const y = surumParcala(b);
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i += 1) {
    const sol = x[i] || 0;
    const sag = y[i] || 0;
    if (sol < sag) return -1;
    if (sol > sag) return 1;
  }
  return 0;
}

function kurulumKok() {
  return join(process.env.LOCALAPPDATA || tmpdir(), "Vega Raporlama");
}

function masaustuKok() {
  return join(process.env.USERPROFILE || "", "Desktop");
}

function kaynakKok() {
  if (paketMi()) return dirname(process.execPath);
  return __dirname;
}

function kuruluExeYolu() {
  // Çalışan exe her zaman hedef (diğer PC kurulum yolları farklı olabilir)
  if (/VegaRaporlama\.exe$/i.test(basename(process.execPath || ""))) return process.execPath;
  if (paketMi()) return process.execPath;
  const local = process.env.LOCALAPPDATA || "";
  const pf = process.env.ProgramFiles || "C:\\Program Files";
  return ilkVarolan([
    join(dirname(process.execPath), "VegaRaporlama.exe"),
    join(local, "Programs", "Vega Raporlama", "VegaRaporlama.exe"),
    join(kurulumKok(), "VegaRaporlama.exe"),
    join(pf, "Vega Raporlama", "VegaRaporlama.exe"),
  ]);
}

function guncellemeLogYaz(mesaj) {
  try {
    const yol = join(kurulumKok(), "guncelleme-log.txt");
    mkdirSync(dirname(yol), { recursive: true });
    writeFileSync(yol, new Date().toISOString() + " " + String(mesaj || "") + "\n", { flag: "a" });
  } catch { /* ok */ }
}

function masaustuBaslatVbsIcerik() {
  const kok = kaynakKok();
  const kurulum = kurulumKok();
  const nodeExe = process.execPath && /node\.exe$/i.test(process.execPath)
    ? process.execPath
    : "C:\\Program Files\\nodejs\\node.exe";
  // VBS'te \ kaçış değil; yalnızca " → ""
  const esc = (p) => String(p || "").replace(/"/g, '""');
  if (paketMi()) {
    return [
      'Set sh = CreateObject("Wscript.Shell")',
      'Set fso = CreateObject("Scripting.FileSystemObject")',
      `klasor = "${esc(kurulum)}"`,
      'exe = klasor & "\\VegaRaporlama.exe"',
      'If fso.FileExists(exe) Then',
      '  sh.CurrentDirectory = klasor',
      '  sh.Run """" & exe & """", 0, False',
      'Else',
      '  MsgBox "VegaRaporlama.exe bulunamadı.", vbExclamation, "Vega Raporlama"',
      'End If',
      "",
    ].join("\r\n");
  }
  // Güncel kaynak: node server.js — port açıksa yalnızca pencereyi getir
  return [
    'Set sh = CreateObject("Wscript.Shell")',
    'Set fso = CreateObject("Scripting.FileSystemObject")',
    `klasor = "${esc(kok)}"`,
    `nodeExe = "${esc(nodeExe)}"`,
    `kurulum = "${esc(kurulum)}"`,
    'serverJs = klasor & "\\server.js"',
    'logDosya = kurulum & "\\baslat.log"',
    'Sub YazLog(m)',
    '  On Error Resume Next',
    '  Dim ts: Set ts = fso.OpenTextFile(logDosya, 8, True)',
    '  ts.WriteLine Now & " " & m',
    '  ts.Close',
    '  On Error GoTo 0',
    'End Sub',
    'Sub PencereAc()',
    '  Dim edge, chrome, userData, cmd',
    '  edge = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"',
    '  If Not fso.FileExists(edge) Then edge = "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"',
    '  chrome = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"',
    '  If Not fso.FileExists(chrome) Then chrome = "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"',
    '  userData = kurulum & "\\pencere"',
    '  If fso.FileExists(edge) Then',
    '    cmd = """" & edge & """ --app=http://127.0.0.1:3850 --user-data-dir=""" & userData & """ --no-first-run --no-default-browser-check --disable-extensions --disable-gpu --disable-features=CalculateNativeWinOcclusion"',
    '  ElseIf fso.FileExists(chrome) Then',
    '    cmd = """" & chrome & """ --app=http://127.0.0.1:3850 --user-data-dir=""" & userData & """ --no-first-run --disable-extensions --disable-gpu --disable-features=CalculateNativeWinOcclusion"',
    '  Else',
    '    cmd = "cmd /c start http://127.0.0.1:3850/"',
    '  End If',
    '  sh.Run cmd, 0, False',
    'End Sub',
    'Function PortAcik()',
    '  On Error Resume Next',
    '  Dim http: Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")',
    '  If http Is Nothing Then Set http = CreateObject("MSXML2.ServerXMLHTTP")',
    '  http.setTimeouts 400, 400, 800, 800',
    '  http.Open "GET", "http://127.0.0.1:3850/", False',
    '  http.Send',
    '  PortAcik = (Err.Number = 0 And http.Status = 200)',
    '  On Error GoTo 0',
    'End Function',
    'If Not fso.FolderExists(klasor) Or Not fso.FileExists(serverJs) Then',
    '  MsgBox "Güncel uygulama klasörü bulunamadı:" & vbCrLf & klasor, vbExclamation, "Vega Raporlama"',
    '  WScript.Quit 1',
    'End If',
    'If Not fso.FileExists(nodeExe) Then',
    '  MsgBox "Node.js bulunamadı:" & vbCrLf & nodeExe, vbExclamation, "Vega Raporlama"',
    '  WScript.Quit 1',
    'End If',
    'If PortAcik() Then',
    '  YazLog "port acik, pencere"',
    '  PencereAc',
    '  WScript.Quit 0',
    'End If',
    'YazLog "sunucu baslat"',
    'sh.CurrentDirectory = klasor',
    'sh.Run """" & nodeExe & """ """ & serverJs & """", 0, False',
    'Dim i',
    'For i = 1 To 30',
    '  WScript.Sleep 500',
    '  If PortAcik() Then',
    '    YazLog "hazir"',
    '    PencereAc',
    '    WScript.Quit 0',
    '  End If',
    'Next',
    'YazLog "zaman asimi"',
    'MsgBox "Vega Raporlama açılamadı. Node başlatılamadı veya port 3850 yanıt vermedi." & vbCrLf & "Log: " & logDosya, vbExclamation, "Vega Raporlama"',
    "",
  ].join("\r\n");
}

function masaustuKisorYolGuncelle() {
  const desk = masaustuKok();
  if (!existsSync(desk)) return;
  const lnk = join(desk, "Vega Raporlama.lnk");
  const kurulum = kurulumKok();
  const exe = join(kurulum, "VegaRaporlama.exe");
  const ico = ilkVarolan([
    join(kurulum, "expert-bilisim.ico"),
    join(kaynakKok(), "assets", "expert-bilisim.ico"),
    join(kaynakKok(), "expert-bilisim.ico"),
  ]);
  // Doğrudan exe Windows Terminal'de siyah konsol açar. Her zaman gizli vbs.
  const hedefExe = existsSync(exe) ? exe : "";
  const hedefVbs = join(kurulum, "baslat.vbs");
  const icoSatir = ico
    ? `$s.IconLocation = '${String(ico).replace(/'/g, "''")},0'`
    : (hedefExe ? `$s.IconLocation = '${hedefExe.replace(/'/g, "''")},0'` : "");
  const ps = [
    `$s = (New-Object -ComObject WScript.Shell).CreateShortcut('${lnk.replace(/'/g, "''")}')`,
    `$s.TargetPath = 'C:\\Windows\\System32\\wscript.exe'`,
    `$s.Arguments = '//B "${hedefVbs.replace(/'/g, "''")}"'`,
    `$s.WorkingDirectory = '${kurulum.replace(/'/g, "''")}'`,
    `$s.Description = 'Vega Raporlama'`,
    `$s.WindowStyle = 7`,
    icoSatir,
    `$s.Save()`,
  ].filter(Boolean).join("; ");
  try {
    execFileSync("powershell.exe", [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-Command", ps,
    ], { windowsHide: true, timeout: 15000 });
  } catch { /* kısayol yazılamadı */ }
}

function masaustuUygulamaIlkAcilisGuncelle() {
  try {
    const kurulum = kurulumKok();
    mkdirSync(kurulum, { recursive: true });
    const vbsKurulum = join(kurulum, "baslat.vbs");
    const vbsMasaustu = join(masaustuKok(), "Vega Raporlama.vbs");
    const exeYol = join(kurulum, "VegaRaporlama.exe");
    const govde = existsSync(exeYol)
      ? [
        'Set sh = CreateObject("Wscript.Shell")',
        'Set fso = CreateObject("Scripting.FileSystemObject")',
        'klasor = sh.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\\Vega Raporlama"',
        'exe = klasor & "\\VegaRaporlama.exe"',
        'If fso.FileExists(exe) Then',
        '  sh.CurrentDirectory = klasor',
        '  sh.Run """" & exe & """", 0, False',
        'Else',
        '  MsgBox "VegaRaporlama.exe bulunamadı.", vbExclamation, "Vega Raporlama"',
        'End If',
        "",
      ].join("\r\n")
      : masaustuBaslatVbsIcerik();
    writeFileSync(vbsKurulum, govde, "utf8");
    try {
      if (existsSync(masaustuKok())) writeFileSync(vbsMasaustu, govde, "utf8");
    } catch { /* masaüstü kilitli */ }
    for (const ad of ["expert-bilisim.ico", "expert-bilisim.png", "expert-logo.png", "expert-logo-teklif.png", "vega-yazilim-logo.png"]) {
      const kaynak = ilkVarolan([
        join(kaynakKok(), "assets", ad),
        join(__dirname, "assets", ad),
        join(kaynakKok(), ad),
      ]);
      const hedef = join(kurulum, ad);
      if (kaynak && kaynak !== hedef) {
        try { copyFileSync(kaynak, hedef); } catch { /* simge kopyalanamadı */ }
      }
    }
    masaustuKisorYolGuncelle();
    googleArkaPlanGorevSenkronize().catch(() => {});
  } catch { /* masaüstü senkron atlandı */ }
}

function guncellemeDurumAl() {
  return {
    ...guncellemeDurum,
    surum: UYGULAMA_SURUM,
    paket: paketMi(),
  };
}

async function githubSonSurum() {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "VegaRaporlama/" + UYGULAMA_SURUM,
  };
  let sonHata = "";
  try {
    const yanit = await fetch(`https://api.github.com/repos/${GUNCELLEME_REPO}/releases/latest`, { headers });
    if (!yanit.ok) throw new Error("GitHub API " + yanit.status);
    const veri = await yanit.json();
    const surum = String(veri.tag_name || "").replace(/^v/i, "");
    const exe = (veri.assets || []).find((a) => /^VegaRaporlama\.exe$/i.test(String(a.name || "")));
    if (!surum) throw new Error("Release sürümü yok.");
    if (!exe?.browser_download_url) throw new Error("Release’te VegaRaporlama.exe yok.");
    return { surum, url: exe.browser_download_url, boyut: Number(exe.size) || 0 };
  } catch (error) {
    sonHata = error.message || String(error);
    guncellemeLogYaz("api: " + sonHata);
  }
  // API kapalı/engelli ise doğrudan latest download + yönlendirme etiketinden sürüm
  const direkt = `https://github.com/${GUNCELLEME_REPO}/releases/latest/download/VegaRaporlama.exe`;
  try {
    const yanit = await fetch(`https://github.com/${GUNCELLEME_REPO}/releases/latest`, {
      headers: { "User-Agent": "VegaRaporlama/" + UYGULAMA_SURUM, Accept: "text/html" },
      redirect: "follow",
    });
    const html = await yanit.text();
    const tag = (html.match(/\/releases\/tag\/v?(\d+\.\d+\.\d+)/) || [])[1]
      || (String(yanit.url || "").match(/\/tag\/v?(\d+\.\d+\.\d+)/) || [])[1]
      || "";
    if (!tag) throw new Error(sonHata || "Sürüm etiketi okunamadı.");
    return { surum: tag, url: direkt, boyut: 0 };
  } catch (error) {
    throw new Error(sonHata || error.message || "GitHub sürüm bilgisi alınamadı.");
  }
}

async function dosyaIndir(url, hedef) {
  const yanit = await fetch(url, {
    headers: { "User-Agent": "VegaRaporlama/" + UYGULAMA_SURUM, Accept: "application/octet-stream" },
    redirect: "follow",
  });
  if (!yanit.ok) throw new Error("İndirme başarısız (" + yanit.status + ").");
  mkdirSync(dirname(hedef), { recursive: true });
  const gecici = hedef + ".part";
  try { unlinkSync(gecici); } catch { /* yok */ }
  const buf = Buffer.from(await yanit.arrayBuffer());
  if (buf.length < 1024 * 1024) throw new Error("İndirilen dosya çok küçük (" + buf.length + ").");
  writeFileSync(gecici, buf);
  try { unlinkSync(hedef); } catch { /* yok */ }
  renameSync(gecici, hedef);
}

function guncellemeUygulanabilirMi() {
  if (process.env.VEGA_GUNCELLEME === "1") return true;
  if (paketMi()) return true;
  if (/VegaRaporlama\.exe$/i.test(basename(process.execPath || ""))) return true;
  // Kaynak (node) ile açılınca da masaüstü/kurulu exe güncellenebilir
  return Boolean(kuruluExeYolu());
}

function exeDosyasiniSessizGuncelle(yeniExe) {
  const hedef = kuruluExeYolu();
  if (!hedef || !existsSync(yeniExe)) throw new Error("Güncelleme hedefi yok.");
  mkdirSync(dirname(hedef), { recursive: true });
  const yedek = hedef + ".eski";
  try { if (existsSync(yedek)) unlinkSync(yedek); } catch { /* ok */ }
  try {
    if (existsSync(hedef)) renameSync(hedef, yedek);
  } catch { /* kilitli olabilir */ }
  copyFileSync(yeniExe, hedef);
  try { if (existsSync(yedek)) unlinkSync(yedek); } catch { /* ok */ }
  try { unlinkSync(yeniExe); } catch { /* ok */ }
  masaustuUygulamaIlkAcilisGuncelle();
}

function psTekTirnak(yazi) {
  return "'" + String(yazi || "").replace(/'/g, "''") + "'";
}

function exeGuncellemesiniUygula(yeniExe) {
  const hedef = kuruluExeYolu();
  if (!hedef || !existsSync(hedef)) throw new Error("Kurulu VegaRaporlama.exe bulunamadı.");
  if (!existsSync(yeniExe)) throw new Error("İndirilen exe yok.");
  const kok = join(process.env.LOCALAPPDATA || tmpdir(), "Vega Raporlama");
  const ps1 = join(kok, "guncelle.ps1");
  const log = join(kok, "guncelleme-log.txt");
  mkdirSync(kok, { recursive: true });
  const pid = process.pid;
  // cmd.exe .cmd dosyasını ANSI okur; kullanıcı adındaki ş/ı yolu bozar ve kopya hiç yazılmaz.
  // PowerShell UTF-8 (BOM) ile yolu olduğu gibi kullanır, denemeleri loglar.
  const govde = [
    "$ErrorActionPreference = 'Continue'",
    `$hedef = ${psTekTirnak(hedef)}`,
    `$yeni = ${psTekTirnak(yeniExe)}`,
    `$log = ${psTekTirnak(log)}`,
    `$eskiPid = ${pid}`,
    "function Yaz([string]$m) {",
    "  $satir = (Get-Date -Format 'yyyy-MM-ddTHH:mm:ss') + ' ' + $m",
    "  Add-Content -LiteralPath $log -Value $satir -Encoding UTF8",
    "}",
    "Yaz ('uygula pid=' + $eskiPid)",
    "$son = (Get-Date).AddSeconds(25)",
    "while ((Get-Date) -lt $son) {",
    "  if (-not (Get-Process -Id $eskiPid -ErrorAction SilentlyContinue)) { break }",
    "  Start-Sleep -Milliseconds 400",
    "}",
    "if (Get-Process -Id $eskiPid -ErrorAction SilentlyContinue) {",
    "  Yaz 'surec kapanmadi, kapatiliyor'",
    "  Stop-Process -Id $eskiPid -Force -ErrorAction SilentlyContinue",
    "  Start-Sleep -Seconds 1",
    "}",
    "$eski = $hedef + '.eski'",
    "$oldu = $false",
    "for ($i = 1; $i -le 30; $i++) {",
    "  try {",
    "    if (Test-Path -LiteralPath $eski) { Remove-Item -LiteralPath $eski -Force -ErrorAction SilentlyContinue }",
    "    if (Test-Path -LiteralPath $hedef) { Rename-Item -LiteralPath $hedef -NewName ([IO.Path]::GetFileName($eski)) -Force }",
    "    Copy-Item -LiteralPath $yeni -Destination $hedef -Force",
    "    $oldu = $true",
    "    break",
    "  } catch {",
    "    Yaz ('deneme ' + $i + ' ' + $_.Exception.Message)",
    "    Start-Sleep -Milliseconds 800",
    "  }",
    "}",
    "if (-not $oldu) { Yaz 'uygulanamadi'; exit 1 }",
    "Yaz 'kopyalandi'",
    "Start-Process -FilePath $hedef -WorkingDirectory ([IO.Path]::GetDirectoryName($hedef))",
    "Remove-Item -LiteralPath $yeni -Force -ErrorAction SilentlyContinue",
    "Remove-Item -LiteralPath $eski -Force -ErrorAction SilentlyContinue",
    "Yaz 'bitti'",
  ].join("\r\n");
  writeFileSync(ps1, "\uFEFF" + govde, "utf8");
  guncellemeLogYaz("uygulama betigi yazildi: " + hedef);
  spawn("powershell.exe", [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", ps1,
  ], { detached: true, windowsHide: true, stdio: "ignore" }).unref();
  setTimeout(() => process.exit(0), 1200);
}

async function guncellemeKontrolEt(otomatikUygula = true) {
  if (process.env.VEGA_GUNCELLEME === "0") {
    guncellemeDurum.durum = "kapali";
    guncellemeDurum.mesaj = "Otomatik güncelleme kapalı.";
    return guncellemeDurumAl();
  }
  if (guncellemeDurum.durum === "indiriliyor" || guncellemeDurum.durum === "uygulaniyor") {
    const zaman = Date.parse(guncellemeDurum.zaman || "") || 0;
    if (Date.now() - zaman < 3 * 60 * 1000) return guncellemeDurumAl();
    guncellemeLogYaz("takili durum sifirlandi: " + guncellemeDurum.durum);
  }
  try {
    guncellemeDurum.durum = "kontrol";
    guncellemeDurum.mesaj = "Sürüm kontrol ediliyor…";
    guncellemeDurum.zaman = new Date().toISOString();
    const son = await githubSonSurum();
    guncellemeDurum.yeniSurum = son.surum;
    if (surumKarsilastir(UYGULAMA_SURUM, son.surum) >= 0) {
      guncellemeDurum.durum = "guncel";
      guncellemeDurum.mesaj = "Uygulama güncel (v" + UYGULAMA_SURUM + ").";
      return guncellemeDurumAl();
    }
    guncellemeDurum.durum = "var";
    guncellemeDurum.mesaj = "Yeni sürüm var: v" + son.surum + " — indiriliyor…";
    if (!otomatikUygula) return guncellemeDurumAl();
    if (!guncellemeUygulanabilirMi()) {
      guncellemeDurum.mesaj = "Yeni sürüm v" + son.surum + " (kurulu uygulamada açıkken otomatik iner).";
      return guncellemeDurumAl();
    }
    if (!kuruluExeYolu()) throw new Error("Kurulu VegaRaporlama.exe bulunamadı.");
    guncellemeDurum.durum = "indiriliyor";
    guncellemeDurum.mesaj = "v" + son.surum + " indiriliyor (program açıkken)…";
    const kok = join(kurulumKok(), "guncelleme");
    mkdirSync(kok, { recursive: true });
    const hedef = join(kok, "VegaRaporlama-" + son.surum + ".exe");
    await dosyaIndir(son.url, hedef);
    const boyut = statSync(hedef).size;
    if (boyut < 1024 * 1024) throw new Error("İndirilen dosya çok küçük.");
    guncellemeDurum.durum = "uygulaniyor";
    // node ile açıksa exe’yi sessiz güncelle (oturumu kapatma); SEA ise yeniden başlat
    if (paketMi() || /VegaRaporlama\.exe$/i.test(basename(process.execPath || ""))) {
      guncellemeDurum.mesaj = "v" + son.surum + " uygulanıyor, uygulama yeniden açılacak…";
      await new Promise((r) => setTimeout(r, 1200));
      exeGuncellemesiniUygula(hedef);
    } else {
      guncellemeDurum.mesaj = "v" + son.surum + " masaüstü uygulamasına uygulanıyor…";
      exeDosyasiniSessizGuncelle(hedef);
      guncellemeDurum.durum = "guncel";
      guncellemeDurum.mesaj = "Masaüstü uygulama güncellendi (v" + son.surum + ").";
      guncellemeDurum.surum = son.surum;
    }
    return guncellemeDurumAl();
  } catch (error) {
    guncellemeDurum.durum = "hata";
    guncellemeDurum.mesaj = error.message || "Güncelleme başarısız.";
    guncellemeLogYaz("hata: " + guncellemeDurum.mesaj);
    return guncellemeDurumAl();
  }
}

let guncellemeZaman = null;

function guncellemeOtomatikKur() {
  if (guncellemeZaman) {
    clearInterval(guncellemeZaman);
    guncellemeZaman = null;
  }
  if (process.env.VEGA_GUNCELLEME === "0") return;
  guncellemeDurum.durum = "bekliyor";
  guncellemeDurum.mesaj = "Açılışta sürüm kontrol ediliyor…";
  const ilk = setTimeout(() => {
    guncellemeKontrolEt(true).catch((e) => guncellemeLogYaz("oto: " + (e.message || e)));
  }, 400);
  if (ilk.unref) ilk.unref();
  guncellemeZaman = setInterval(() => {
    guncellemeKontrolEt(true).catch((e) => guncellemeLogYaz("periyot: " + (e.message || e)));
  }, 5 * 60 * 1000);
  if (guncellemeZaman.unref) guncellemeZaman.unref();
}

const GIRIS_PENCERE = { genislik: 460, yukseklik: 640 };

function konsolAcikMi() {
  return process.env.VEGA_KONSOL === "1";
}

function konsoluGizle() {
  if (process.platform !== "win32" || konsolAcikMi()) return;
  try {
    const { execFileSync } = require("node:child_process");
    execFileSync("powershell.exe", [
      "-NoProfile",
      "-WindowStyle", "Hidden",
      "-Command",
      `Add-Type -Namespace Vega -Name Konsol -MemberDefinition '[DllImport("kernel32.dll")] public static extern bool FreeConsole(); [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow(); [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);'; $h = [Vega.Konsol]::GetConsoleWindow(); if ($h -ne [IntPtr]::Zero) { [Vega.Konsol]::ShowWindow($h, 0) | Out-Null }; [Vega.Konsol]::FreeConsole() | Out-Null; $p = Get-Process -Id ${process.pid} -ErrorAction SilentlyContinue; if ($p -and $p.MainWindowHandle -ne [IntPtr]::Zero) { [Vega.Konsol]::ShowWindow($p.MainWindowHandle, 0) | Out-Null }`,
    ], { windowsHide: true, timeout: 4000 });
  } catch {
    execFile("powershell.exe", [
      "-NoProfile",
      "-WindowStyle", "Hidden",
      "-Command",
      `Add-Type -Namespace Vega -Name Pencere -MemberDefinition '[DllImport("kernel32.dll")] public static extern bool FreeConsole(); [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow(); [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);'; $h = [Vega.Pencere]::GetConsoleWindow(); if ($h -ne [IntPtr]::Zero) { [Vega.Pencere]::ShowWindow($h, 0) | Out-Null }; [Vega.Pencere]::FreeConsole() | Out-Null; $p = Get-Process -Id ${process.pid} -ErrorAction SilentlyContinue; if ($p -and $p.MainWindowHandle -ne [IntPtr]::Zero) { [Vega.Pencere]::ShowWindow($p.MainWindowHandle, 0) | Out-Null }`,
    ], { windowsHide: true });
  }
}

konsoluGizle();
setTimeout(konsoluGizle, 200);
setTimeout(konsoluGizle, 800);

function pencereOlcuDosya() {
  return join(process.env.LOCALAPPDATA || tmpdir(), "Vega Raporlama", "pencere-olcu.json");
}

function pencereOlcuOku() {
  try {
    return JSON.parse(readFileSync(pencereOlcuDosya(), "utf8"));
  } catch {
    return null;
  }
}

function pencereArguman(adres, profil) {
  const arguman = [
    "--app=" + adres,
    "--user-data-dir=" + profil,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-sync",
    "--disable-gpu",
    "--disable-features=CalculateNativeWinOcclusion",
  ];
  arguman.push("--window-size=" + GIRIS_PENCERE.genislik + "," + GIRIS_PENCERE.yukseklik);
  return arguman;
}

function uygulamaPenceresi(adres, izle = true) {
  if (process.env.VEGA_PENCERE === "0") return;
  const tarayici = edgeBul();
  if (!tarayici) {
    execFile("cmd.exe", ["/c", "start", "", adres], { windowsHide: true });
    return;
  }
  const profil = join(process.env.LOCALAPPDATA || tmpdir(), "Vega Raporlama", "pencere");
  mkdirSync(profil, { recursive: true });
  // windowsHide:false — aksi halde bazı sistemlerde Chrome uygulama penceresi hiç görünmüyor.
  const child = spawn(tarayici, pencereArguman(adres, profil), {
    detached: true,
    windowsHide: false,
    stdio: "ignore",
  });
  child.unref();
  child.on("error", () => {
    execFile("cmd.exe", ["/c", "start", "", adres], { windowsHide: true });
  });
  if (!izle) return;
  const bas = Date.now();
  let goruldu = false;
  let kapaliArdisik = 0;
  const denetle = () => {
    execFile("powershell.exe", [
      "-NoProfile",
      "-WindowStyle", "Hidden",
      "-Command",
      "$bul = Get-CimInstance Win32_Process -Filter \"Name='$env:VEGA_PENCERE_AD'\" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($env:VEGA_PENCERE_IZ) }; if ($bul) { 'acik' } else { 'kapali' }",
    ], {
      windowsHide: true,
      timeout: 15000,
      env: { ...process.env, VEGA_PENCERE_AD: basename(tarayici), VEGA_PENCERE_IZ: "--app=" + adres },
    }, (error, stdout) => {
      if (error) return;
      const cikti = String(stdout || "");
      if (cikti.includes("acik")) {
        goruldu = true;
        kapaliArdisik = 0;
        return;
      }
      if (!goruldu || !cikti.includes("kapali")) return;
      kapaliArdisik += 1;
      if (kapaliArdisik >= 2 && Date.now() - bas > 12000) process.exit(0);
    });
  };
  const zaman = setInterval(denetle, 3000);
  zaman.unref();
}

function uygulamayiKapat() {
  const tarayici = edgeBul();
  const profil = join(process.env.LOCALAPPDATA || tmpdir(), "Vega Raporlama", "pencere");
  const ad = tarayici ? basename(tarayici) : "msedge.exe";
  execFile("powershell.exe", [
    "-NoProfile",
    "-WindowStyle", "Hidden",
    "-Command",
    "Get-CimInstance Win32_Process -Filter \"Name='$env:VEGA_PENCERE_AD'\" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($env:VEGA_PENCERE_PROFIL) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
  ], {
    windowsHide: true,
    timeout: 8000,
    env: { ...process.env, VEGA_PENCERE_AD: ad, VEGA_PENCERE_PROFIL: profil },
  }, () => {
    setTimeout(() => process.exit(0), 200);
  });
  setTimeout(() => process.exit(0), 2500);
}

async function htmlPdf(html) {
  const tarayici = edgeBul();
  if (!tarayici) throw new Error("PDF için Microsoft Edge bulunamadı.");
  const kok = join(tmpdir(), "vega-pdf-" + randomBytes(6).toString("hex"));
  mkdirSync(kok, { recursive: true });
  const htmlDosya = join(kok, "ekstre.html");
  const pdfDosya = join(kok, "ekstre.pdf");
  writeFileSync(htmlDosya, html, "utf8");
  const adres = "file:///" + htmlDosya.replace(/\\/g, "/");
  const arguman = (baslik) => [
    baslik,
    "--disable-gpu",
    "--no-first-run",
    "--no-pdf-header-footer",
    "--virtual-time-budget=4000",
    "--user-data-dir=" + join(kok, "profil"),
    "--print-to-pdf=" + pdfDosya,
    adres,
  ];
  let pdf = null;
  try {
    for (const baslik of ["--headless=new", "--headless"]) {
      try {
        await execFileAsync(tarayici, arguman(baslik), { windowsHide: true, timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
      } catch { /* Edge bazen dosyayı yazıp hata kodu döndürür */ }
      if (existsSync(pdfDosya)) {
        pdf = readFileSync(pdfDosya);
        break;
      }
    }
  } finally {
    try { rmSync(kok, { recursive: true, force: true }); } catch { /* geçici klasör silinemedi */ }
  }
  if (!pdf) throw new Error("PDF oluşturulamadı.");
  return pdf;
}

const WHATSAPP_ARALIK_MS = 5 * 60 * 1000;
let waSonGonderim = 0;
let waSirasi = Promise.resolve();

function whatsappSirayaAl(islem) {
  const siradaki = waSirasi.then(async () => {
    const kalan = waSonGonderim ? WHATSAPP_ARALIK_MS - (Date.now() - waSonGonderim) : 0;
    if (kalan > 0) await new Promise((resolve) => setTimeout(resolve, kalan));
    try {
      return await islem();
    } finally {
      waSonGonderim = Date.now();
    }
  });
  waSirasi = siradaki.then(() => {}, () => {});
  return siradaki;
}

async function whatsappPdf(telefon, pdf, dosyaAdi, ozet) {
  if (wa.durum !== "bagli" || !wa.sock) throw new Error("Önce telefonu QR ile bağlayın.");
  return whatsappSirayaAl(() => whatsappPdfGonder(telefon, pdf, dosyaAdi, ozet));
}

async function whatsappPdfGonder(telefon, pdf, dosyaAdi, ozet) {
  if (wa.durum !== "bagli" || !wa.sock) throw new Error("Önce telefonu QR ile bağlayın.");
  const bulunan = await wa.sock.onWhatsApp(telefon);
  const sonuc = Array.isArray(bulunan) ? bulunan.find((kayit) => kayit?.jid) : null;
  if (!sonuc) throw new Error("Bu numara WhatsApp'ta bulunamadı.");
  const ad = String(dosyaAdi || "hesap-ekstresi.pdf").replace(/[\\/:*?"<>|]/g, "").slice(0, 80) || "hesap-ekstresi.pdf";
  const yazi = String(ozet || "Detaylı hesap ekstreniz ekte bilgilerinize sunulmuştur.\nExpert Bilişim").slice(0, 1000);
  await wa.sock.sendMessage(sonuc.jid, { text: yazi });
  const giden = await wa.sock.sendMessage(sonuc.jid, {
    document: pdf,
    mimetype: "application/pdf",
    fileName: ad.toLowerCase().endsWith(".pdf") ? ad : ad + ".pdf",
    caption: yazi,
  });
  return { id: giden?.key?.id || "" };
}

const FATURA_XSLT = "C:\\eArsiv\\invoice.xslt";
const FATURA_TEMP = "C:\\eArsiv\\temp";
const XSLT_PS = [
  "$ErrorActionPreference = 'Stop'",
  "$yuklu = ''",
  "$xslt = $null",
  "[Console]::Out.WriteLine('HAZIR')",
  "while ($true) {",
  "  $line = [Console]::In.ReadLine()",
  "  if ([string]::IsNullOrWhiteSpace($line)) { continue }",
  "  if ($line -eq 'CIK') { break }",
  "  $p = $line.Split('|')",
  "  if ($p.Length -lt 3) { [Console]::Out.WriteLine('HATA'); continue }",
  "  try {",
  "    if ($yuklu -ne $p[0]) {",
  "      $xslt = New-Object System.Xml.Xsl.XslCompiledTransform",
  "      $xslt.Load($p[0])",
  "      $yuklu = $p[0]",
  "    }",
  "    $xslt.Transform($p[1], $p[2])",
  "    [Console]::Out.WriteLine('OK')",
  "  } catch {",
  "    $yuklu = ''",
  "    [Console]::Out.WriteLine('HATA')",
  "  }",
  "}",
].join("\r\n");
let xsltProc = null;
let xsltZincir = Promise.resolve();
const faturaHtmlOnbellek = new Map();

function xmlKacis(deger) {
  return String(deger ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&apos;",
  }[ch]));
}

function paraXml(deger) {
  return (Math.round((Number(deger) || 0) * 100) / 100).toFixed(2);
}

function tutarYazi(tutar) {
  const birler = ["", "bir", "iki", "üç", "dört", "beş", "altı", "yedi", "sekiz", "dokuz"];
  const onlar = ["", "on", "yirmi", "otuz", "kırk", "elli", "altmış", "yetmiş", "seksen", "doksan"];
  const grup = (n) => {
    const yuz = Math.floor(n / 100);
    const on = Math.floor((n % 100) / 10);
    const bir = n % 10;
    return (yuz > 1 ? birler[yuz] : "") + (yuz ? "yüz" : "") + onlar[on] + birler[bir];
  };
  const sabit = Math.round((Number(tutar) || 0) * 100);
  let lira = Math.floor(sabit / 100);
  const kurus = Math.abs(sabit % 100);
  const bolum = [];
  const ekle = (adet, ad) => {
    if (!adet) return;
    bolum.push((ad === "bin" && adet === 1 ? "" : grup(adet)) + ad);
  };
  ekle(Math.floor(lira / 1000000000), "milyar");
  lira %= 1000000000;
  ekle(Math.floor(lira / 1000000), "milyon");
  lira %= 1000000;
  ekle(Math.floor(lira / 1000), "bin");
  lira %= 1000;
  if (lira) bolum.push(grup(lira));
  let yazi = "Yalnız " + (bolum.join(" ") || "sıfır").toLocaleUpperCase("tr-TR") + " TL";
  if (kurus) yazi += " " + grup(kurus).toLocaleUpperCase("tr-TR") + " KRŞ";
  return yazi;
}

function htmlCoz(yol) {
  const buf = readFileSync(yol);
  const html = buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe
    ? buf.toString("utf16le")
    : buf.toString("utf8");
  return html.replace(/charset=utf-16/ig, "charset=utf-8");
}

function hazirFaturaHtml(no) {
  if (!existsSync(FATURA_TEMP)) return "";
  let secilen = "";
  let zaman = 0;
  for (const ad of readdirSync(FATURA_TEMP)) {
    if (!ad.toLowerCase().endsWith(".html")) continue;
    const yol = join(FATURA_TEMP, ad);
    let html = "";
    try { html = htmlCoz(yol); } catch { continue; }
    if (!html.includes(`"no":"${no}"`)) continue;
    const mtime = statSync(yol).mtimeMs;
    if (mtime >= zaman) {
      zaman = mtime;
      secilen = html;
    }
  }
  return secilen;
}

function saticiXml() {
  if (!existsSync(FATURA_TEMP)) return "";
  const dosyalar = readdirSync(FATURA_TEMP).filter((ad) => ad.endsWith("_dump.xml"));
  dosyalar.sort((a, b) => statSync(join(FATURA_TEMP, b)).mtimeMs - statSync(join(FATURA_TEMP, a)).mtimeMs);
  for (const ad of dosyalar) {
    try {
      const xml = readFileSync(join(FATURA_TEMP, ad), "utf8");
      const eslesen = xml.match(/<cac:AccountingSupplierParty>[\s\S]*?<\/cac:AccountingSupplierParty>/);
      if (eslesen) return eslesen[0];
    } catch { /* döküm okunamadı */ }
  }
  return `<cac:AccountingSupplierParty><cac:Party><cac:PartyName><cbc:Name>EXPERT BİLİŞİM</cbc:Name></cac:PartyName></cac:Party></cac:AccountingSupplierParty>`;
}

function xsltProcAl() {
  if (xsltProc && xsltProc.exitCode == null) return xsltProc;
  const ps1 = join(tmpdir(), "vega-fatura-xslt.ps1");
  writeFileSync(ps1, XSLT_PS, "utf8");
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-File", ps1], {
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.buf = "";
  child.kuyruk = [];
  child.stdout.on("data", (chunk) => {
    child.buf += chunk.toString("utf8");
    let kesim = child.buf.indexOf("\n");
    while (kesim >= 0) {
      const satir = child.buf.slice(0, kesim).replace(/\r/g, "").trim();
      child.buf = child.buf.slice(kesim + 1);
      if (satir === "OK" || satir === "HATA") {
        const bekleyen = child.kuyruk.shift();
        if (bekleyen) bekleyen(satir);
      }
      kesim = child.buf.indexOf("\n");
    }
  });
  child.on("exit", () => {
    for (const bekleyen of child.kuyruk) bekleyen("HATA");
    if (xsltProc === child) xsltProc = null;
  });
  xsltProc = child;
  return child;
}

function xsltDonustur(xml, xsltYol) {
  const is = xsltZincir.then(() => new Promise((resolve, reject) => {
    const id = randomBytes(8).toString("hex");
    const xmlYol = join(tmpdir(), `vega-ubl-${id}.xml`);
    const htmlYol = join(tmpdir(), `vega-ubl-${id}.html`);
    writeFileSync(xmlYol, xml, "utf8");
    const child = xsltProcAl();
    const zaman = setTimeout(() => {
      reject(new Error("Fatura görseli hazırlanamadı."));
    }, 25000);
    child.kuyruk.push((sonuc) => {
      clearTimeout(zaman);
      try { unlinkSync(xmlYol); } catch { /* geçici xml silinemedi */ }
      if (sonuc !== "OK" || !existsSync(htmlYol)) {
        reject(new Error("Fatura görseli hazırlanamadı."));
        return;
      }
      const html = htmlCoz(htmlYol);
      try { unlinkSync(htmlYol); } catch { /* geçici html silinemedi */ }
      resolve(html);
    });
    const sablon = xsltYol && existsSync(xsltYol) ? xsltYol : FATURA_XSLT;
    child.stdin.write(`${sablon}|${xmlYol}|${htmlYol}\n`);
  }));
  xsltZincir = is.catch(() => {});
  return is;
}

function birimKodu(birim) {
  const ad = String(birim || "").trim().toUpperCase();
  const kodlar = { ADET: "NIU", AD: "NIU", KG: "KGM", KILOGRAM: "KGM", LT: "LTR", LITRE: "LTR", M: "MTR", M2: "MTK", M3: "MTQ", PAKET: "PA", KUTU: "BX" };
  if (kodlar[ad]) return kodlar[ad];
  if (/^[A-Z0-9]{2,3}$/.test(ad)) return ad;
  return "NIU";
}

async function faturaUbl(firma, donem, no) {
  const cari = firmaTablo(firma, "TBLCARI");
  const yazi = (ifade) => `REPLACE(REPLACE(REPLACE(RTRIM(ISNULL(${ifade}, N'')), N'|', N'/'), CHAR(13), N' '), CHAR(10), N' ')`;
  let baslik = null;
  let satirlar = [];
  for (const ad of ["TBLSATFAT", "TBLPSATFAT"]) {
    const baslikTablo = donemTablo(firma, donem, ad + "BASLIK");
    const hareketTablo = donemTablo(firma, donem, ad + "HAREKET");
    try {
      const baslikSatir = await queryLines(`
SET NOCOUNT ON;
SELECT
  CONVERT(varchar(10), b.TARIH, 23),
  REPLACE(REPLACE(RTRIM(ISNULL(CAST(b.EFATURAUUID AS nvarchar(40)), N'')), N'{', N''), N'}', N''),
  CAST(ISNULL(b.TUTAR, 0) AS decimal(18, 2)),
  ${yazi("c.FIRMAADI")},
  ${yazi("CAST(c.ADRESFATURA AS nvarchar(300))")},
  ${yazi("c.IL")},
  ${yazi("c.SEHIR")},
  ${yazi("c.VERGIDAIRESI")},
  ${yazi("c.VERGINO")},
  ${yazi("c.EMAIL")},
  ${yazi("c.TELEFON1")}
FROM ${baslikTablo} b
JOIN ${cari} c ON c.IND = b.FIRMANO
WHERE RTRIM(b.BELGENO) = N'${no}';
`);
      if (!baslikSatir.length) continue;
      const [tarih, uuid, tutar, firmaAdi, adres, ilce, sehir, vergiDairesi, vergiNo, eposta, telefon] = baslikSatir[0].split("|").map((part) => part.trim());
      baslik = { tarih, uuid, tutar: Number(tutar) || 0, firmaAdi, adres, ilce, sehir, vergiDairesi, vergiNo, eposta, telefon };
      satirlar = await queryLines(`
SET NOCOUNT ON;
SELECT
  CAST(ISNULL(h.SATIRNO, 0) AS varchar(6)),
  ${yazi("h.MALINCINSI")},
  CAST(ISNULL(h.MIKTAR, 0) AS decimal(18, 2)),
  ${yazi("h.BIRIM")},
  CAST(ISNULL(h.FIYATI, 0) AS decimal(18, 2)),
  CAST(ISNULL(h.KDV, 0) AS decimal(18, 2)),
  CAST(ISNULL(h.GERCEKTOPLAM, 0) AS decimal(18, 2))
FROM ${hareketTablo} h
JOIN ${baslikTablo} b ON b.IND = h.EVRAKNO
WHERE RTRIM(b.BELGENO) = N'${no}'
ORDER BY h.SATIRNO, h.IND;
`);
      break;
    } catch { /* bu fatura tablosu yok */ }
  }
  if (!baslik || !satirlar.length) return "";
  const kalemler = satirlar.map((line) => {
    const [sira, ad, miktar, birim, fiyat, kdv, net] = line.split("|").map((part) => part.trim());
    const adet = Number(miktar) || 0;
    const birimFiyat = Number(fiyat) || 0;
    const brut = Math.round(adet * birimFiyat * 100) / 100;
    const tutar = Number(net) > 0 ? Number(net) : brut;
    const iskonto = Math.max(0, Math.round((brut - tutar) * 100) / 100);
    const oran = Number(kdv) || 0;
    const kdvTutar = Math.round(tutar * oran) / 100;
    return { sira: sira || "1", ad, adet, birim, birimFiyat, tutar, iskonto, oran, kdvTutar };
  });
  const ara = kalemler.reduce((toplam, kalem) => toplam + kalem.tutar, 0);
  const iskonto = kalemler.reduce((toplam, kalem) => toplam + kalem.iskonto, 0);
  const gruplar = new Map();
  for (const kalem of kalemler) {
    const grup = gruplar.get(kalem.oran) || { oran: kalem.oran, matrah: 0, vergi: 0 };
    grup.matrah += kalem.tutar;
    grup.vergi += kalem.kdvTutar;
    gruplar.set(kalem.oran, grup);
  }
  let kdvTutar = [...gruplar.values()].reduce((toplam, grup) => toplam + grup.vergi, 0);
  let odenecek = Math.round((ara + kdvTutar) * 100) / 100;
  if (baslik.tutar > 0 && Math.abs(baslik.tutar - odenecek) < 1 && gruplar.size === 1) {
    const fark = Math.round((baslik.tutar - ara) * 100) / 100;
    const tek = [...gruplar.values()][0];
    tek.vergi = fark;
    kdvTutar = fark;
    odenecek = baslik.tutar;
  }
  const vergiNo = baslik.vergiNo.replace(/\D/g, "");
  const kimlik = vergiNo.length === 11 ? "TCKN" : "VKN";
  const uuid = baslik.uuid || randomBytes(16).toString("hex").replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5").toUpperCase();
  const satirXml = kalemler.map((kalem) => `<cac:InvoiceLine>
    <cbc:ID>${xmlKacis(kalem.sira)}</cbc:ID>
    <cbc:InvoicedQuantity unitCode="${birimKodu(kalem.birim)}">${paraXml(kalem.adet)}</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount currencyID="TRY">${paraXml(kalem.tutar)}</cbc:LineExtensionAmount>
    ${kalem.iskonto > 0 ? `<cac:AllowanceCharge><cbc:ChargeIndicator>false</cbc:ChargeIndicator><cbc:Amount currencyID="TRY">${paraXml(kalem.iskonto)}</cbc:Amount></cac:AllowanceCharge>` : ""}
    <cac:TaxTotal><cbc:TaxAmount currencyID="TRY">${paraXml(kalem.kdvTutar)}</cbc:TaxAmount>
      <cac:TaxSubtotal>
        <cbc:TaxableAmount currencyID="TRY">${paraXml(kalem.tutar)}</cbc:TaxableAmount>
        <cbc:TaxAmount currencyID="TRY">${paraXml(kalem.kdvTutar)}</cbc:TaxAmount>
        <cbc:Percent>${paraXml(kalem.oran)}</cbc:Percent>
        <cac:TaxCategory><cac:TaxScheme><cbc:Name>KDV</cbc:Name><cbc:TaxTypeCode>0015</cbc:TaxTypeCode></cac:TaxScheme></cac:TaxCategory>
      </cac:TaxSubtotal>
    </cac:TaxTotal>
    <cac:Item><cbc:Name>${xmlKacis(kalem.ad)}</cbc:Name></cac:Item>
    <cac:Price><cbc:PriceAmount currencyID="TRY">${paraXml(kalem.birimFiyat)}</cbc:PriceAmount></cac:Price>
  </cac:InvoiceLine>`).join("");
  const vergiXml = [...gruplar.values()].map((grup) => `<cac:TaxSubtotal>
    <cbc:TaxableAmount currencyID="TRY">${paraXml(grup.matrah)}</cbc:TaxableAmount>
    <cbc:TaxAmount currencyID="TRY">${paraXml(grup.vergi)}</cbc:TaxAmount>
    <cbc:CalculationSequenceNumeric>1</cbc:CalculationSequenceNumeric>
    <cbc:Percent>${paraXml(grup.oran)}</cbc:Percent>
    <cac:TaxCategory><cac:TaxScheme><cbc:Name>KDV</cbc:Name><cbc:TaxTypeCode>0015</cbc:TaxTypeCode></cac:TaxScheme></cac:TaxCategory>
  </cac:TaxSubtotal>`).join("");
  return `<?xml version="1.0" encoding="utf-8"?>
<Invoice xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2" xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2" xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2">
  <cbc:UBLVersionID>2.1</cbc:UBLVersionID>
  <cbc:CustomizationID>TR1.2</cbc:CustomizationID>
  <cbc:ProfileID>TICARIFATURA</cbc:ProfileID>
  <cbc:ID>${xmlKacis(no)}</cbc:ID>
  <cbc:CopyIndicator>false</cbc:CopyIndicator>
  <cbc:UUID>${xmlKacis(uuid)}</cbc:UUID>
  <cbc:IssueDate>${xmlKacis(baslik.tarih)}</cbc:IssueDate>
  <cbc:InvoiceTypeCode>SATIS</cbc:InvoiceTypeCode>
  <cbc:Note>${xmlKacis(tutarYazi(odenecek))}</cbc:Note>
  <cbc:DocumentCurrencyCode>TRY</cbc:DocumentCurrencyCode>
  <cbc:LineCountNumeric>${kalemler.length}</cbc:LineCountNumeric>
  ${saticiXml()}
  <cac:AccountingCustomerParty><cac:Party>
    ${vergiNo ? `<cac:PartyIdentification><cbc:ID schemeID="${kimlik}">${xmlKacis(vergiNo)}</cbc:ID></cac:PartyIdentification>` : ""}
    <cac:PartyName><cbc:Name>${xmlKacis(baslik.firmaAdi)}</cbc:Name></cac:PartyName>
    <cac:PostalAddress>
      <cbc:StreetName>${xmlKacis(baslik.adres)}</cbc:StreetName>
      <cbc:CitySubdivisionName>${xmlKacis(baslik.ilce)}</cbc:CitySubdivisionName>
      <cbc:CityName>${xmlKacis(baslik.sehir)}</cbc:CityName>
      <cac:Country><cbc:Name>Türkiye</cbc:Name></cac:Country>
    </cac:PostalAddress>
    <cac:PartyTaxScheme><cac:TaxScheme><cbc:Name>${xmlKacis(baslik.vergiDairesi)}</cbc:Name></cac:TaxScheme></cac:PartyTaxScheme>
    <cac:Contact>
      ${baslik.telefon ? `<cbc:Telephone>${xmlKacis(baslik.telefon)}</cbc:Telephone>` : ""}
      ${baslik.eposta ? `<cbc:ElectronicMail>${xmlKacis(baslik.eposta)}</cbc:ElectronicMail>` : ""}
    </cac:Contact>
  </cac:Party></cac:AccountingCustomerParty>
  <cac:TaxTotal><cbc:TaxAmount currencyID="TRY">${paraXml(kdvTutar)}</cbc:TaxAmount>${vergiXml}</cac:TaxTotal>
  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="TRY">${paraXml(ara)}</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="TRY">${paraXml(ara)}</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="TRY">${paraXml(odenecek)}</cbc:TaxInclusiveAmount>
    <cbc:AllowanceTotalAmount currencyID="TRY">${paraXml(iskonto)}</cbc:AllowanceTotalAmount>
    <cbc:PayableAmount currencyID="TRY">${paraXml(odenecek)}</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>
  ${satirXml}
</Invoice>`;
}

function gomuluSablon(xml) {
  const blok = /<cbc:EmbeddedDocumentBinaryObject\b([^>]*)>([\s\S]*?)<\/cbc:EmbeddedDocumentBinaryObject>/gi;
  let eslesen;
  while ((eslesen = blok.exec(xml))) {
    if (!/\.xslt/i.test(eslesen[1])) continue;
    try {
      const metin = Buffer.from(eslesen[2].replace(/\s+/g, ""), "base64").toString("utf8").replace(/^\uFEFF/, "");
      if (metin.includes("xsl:stylesheet")) return metin;
    } catch { /* gömülü şablon çözülemedi */ }
  }
  return "";
}

function gelenFaturaXml(firma, donem, no) {
  const tablo = donemTablo(firma, donem, "TBLEFAINBOX");
  if (!/^F\d{4}D\d{4}TBLEFAINBOX$/.test(tablo)) return Promise.resolve("");
  const id = randomBytes(6).toString("hex");
  const out = join(tmpdir(), `vega-gelen-${id}.xml`);
  const ps1 = join(tmpdir(), `vega-gelen-${id}.ps1`);
  const sunucu = String(link.server || "(local)").replace(/'/g, "''");
  const veritabani = String(link.database || "VEGADB").replace(/'/g, "''");
  writeFileSync(ps1, [
    "$ErrorActionPreference='Stop'",
    `$con = New-Object System.Data.SqlClient.SqlConnection "Data Source=${sunucu};Initial Catalog=${veritabani};Integrated Security=True"`,
    "$con.Open()",
    "$cmd = $con.CreateCommand()",
    `$cmd.CommandText = "SELECT TOP 1 CAST(RAWINVOICE AS varbinary(max)) FROM ${tablo} WHERE RTRIM(Evrakno)=@no AND RAWINVOICE IS NOT NULL ORDER BY IND DESC"`,
    "$p = $cmd.Parameters.Add('@no',[Data.SqlDbType]::NVarChar,40)",
    `$p.Value = '${no.replace(/'/g, "''")}'`,
    "$bytes = $cmd.ExecuteScalar()",
    "$con.Close()",
    "if ($bytes -isnot [byte[]] -or $bytes.Length -lt 20) { 'YOK'; exit 0 }",
    `[IO.File]::WriteAllBytes('${out.replace(/'/g, "''")}', $bytes)`,
    "'OK'",
  ].join("\r\n"), "utf8");
  return execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-File", ps1], { windowsHide: true, timeout: 20000 })
    .then(() => {
      try { unlinkSync(ps1); } catch { /* geçici komut silinemedi */ }
      if (!existsSync(out)) return "";
      const buf = readFileSync(out);
      try { unlinkSync(out); } catch { /* geçici xml silinemedi */ }
      if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.toString("utf16le");
      return buf.toString("utf8");
    })
    .catch(() => "");
}

async function gelenHtml(xml) {
  const sablon = gomuluSablon(xml);
  let ozel = "";
  if (sablon.includes("xsl:stylesheet")) {
    ozel = join(tmpdir(), `vega-sablon-${randomBytes(6).toString("hex")}.xslt`);
    writeFileSync(ozel, sablon, "utf8");
    try {
      return await xsltDonustur(xml, ozel);
    } catch { /* gelen şablon açılmadı */ }
    finally {
      try { unlinkSync(ozel); } catch { /* geçici şablon silinemedi */ }
    }
  }
  return xsltDonustur(xml, FATURA_XSLT);
}

async function faturaGorunumHtml(firma, donem, no) {
  const anahtar = firma + ":" + donem + ":" + no;
  const onbellek = faturaHtmlOnbellek.get(anahtar);
  if (onbellek) return onbellek;
  let html = "";
  const gelen = await gelenFaturaXml(firma, donem, no);
  if (gelen.includes("<Invoice") && existsSync(FATURA_XSLT)) {
    try { html = await gelenHtml(gelen); } catch { html = ""; }
  }
  if (!html) html = hazirFaturaHtml(no);
  if (!html && existsSync(FATURA_XSLT)) {
    const xml = await faturaUbl(firma, donem, no);
    if (xml) {
      try { html = await xsltDonustur(xml, FATURA_XSLT); } catch { html = ""; }
    }
  }
  if (!html) return "";
  if (faturaHtmlOnbellek.size > 40) faturaHtmlOnbellek.clear();
  faturaHtmlOnbellek.set(anahtar, html);
  return html;
}

function resimTuru(buf) {
  if (!buf || buf.length < 4) return "";
  if (buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
  if (buf[0] === 0x89 && buf[1] === 0x50) return "image/png";
  if (buf[0] === 0x47 && buf[1] === 0x49) return "image/gif";
  if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return "";
}

const urunInternetOnbellek = new Map();

function urunInternetKisa(metin) {
  const temiz = String(metin || "").replace(/\[[^\]]+\]/g, " ").replace(/\s+/g, " ").trim();
  if (temiz.length < 24) return "";
  const cumle = temiz.split(/(?<=\.)\s+/).slice(0, 2).join(" ");
  return (cumle || temiz).slice(0, 280).trim();
}

function urunInternetKelime(metin) {
  return String(metin || "")
    .toLocaleLowerCase("tr-TR")
    .replace(/ı/g, "i")
    .split(/[^a-z0-9çğıöşü]+/i)
    .filter((kelime) => kelime.length > 2);
}

function urunInternetIlgili(sorgu, baslik, metin) {
  const aranan = urunInternetKelime(sorgu);
  if (!aranan.length) return false;
  const hedef = urunInternetKelime(baslik + " " + metin);
  const kume = new Set(hedef);
  return aranan.some((kelime) => kume.has(kelime) || hedef.some((aday) => aday.startsWith(kelime) || kelime.startsWith(aday)));
}

function wikimediaAdres(adres) {
  try {
    const url = new URL(String(adres || ""));
    if (url.protocol !== "https:") return "";
    const host = url.hostname.toLowerCase();
    if (host !== "upload.wikimedia.org" && host !== "thumb.wikimedia.org") return "";
    return url.toString();
  } catch {
    return "";
  }
}

async function urunInternetIndir(adres) {
  const guvenli = wikimediaAdres(adres);
  if (!guvenli) return "";
  const yanit = await fetch(guvenli, {
    headers: { "User-Agent": "VegaRaporlama/1.2 (teklif urun)", Accept: "image/*" },
    signal: AbortSignal.timeout(8000),
  });
  if (!yanit.ok) return "";
  const buf = Buffer.from(await yanit.arrayBuffer());
  if (buf.length < 80 || buf.length > 900000) return "";
  const tur = resimTuru(buf);
  if (!tur) return "";
  return "data:" + tur + ";base64," + buf.toString("base64");
}

function disResimAdres(adres) {
  try {
    const url = new URL(String(adres || ""));
    if (url.protocol !== "https:") return "";
    const host = url.hostname.toLowerCase();
    if (!host || host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) return "";
    if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(host)) return "";
    return url.toString();
  } catch {
    return "";
  }
}

async function urunDisResimIndir(adres) {
  const guvenli = disResimAdres(adres);
  if (!guvenli) return "";
  const yanit = await fetch(guvenli, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(8000),
  });
  if (!yanit.ok) return "";
  let son = "";
  try { son = new URL(yanit.url).protocol; } catch { son = ""; }
  if (son !== "https:") return "";
  const buf = Buffer.from(await yanit.arrayBuffer());
  if (buf.length < 80 || buf.length > 900000) return "";
  const tur = resimTuru(buf);
  if (!tur) return "";
  return "data:" + tur + ";base64," + buf.toString("base64");
}

async function urunAdGorselBul(sorgu) {
  const q = String(sorgu || "").replace(/\s+/g, " ").trim().slice(0, 120);
  if (q.length < 3) return "";
  const anahtar = "g:" + q.toLocaleLowerCase("tr-TR");
  if (urunInternetOnbellek.has(anahtar)) return urunInternetOnbellek.get(anahtar);
  const baslik = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    Accept: "text/html",
  };
  let resim = "";
  try {
    const sayfa = await fetch("https://duckduckgo.com/?q=" + encodeURIComponent(q), {
      headers: baslik,
      signal: AbortSignal.timeout(8000),
    });
    const html = await sayfa.text();
    const vqd = (html.match(/vqd="([^"]+)"/) || html.match(/vqd=([\d-]+)/) || [])[1];
    if (vqd) {
      const yanit = await fetch(
        "https://duckduckgo.com/i.js?l=tr-tr&o=json&q=" + encodeURIComponent(q) + "&vqd=" + encodeURIComponent(vqd) + "&p=1",
        { headers: { ...baslik, Accept: "application/json", Referer: "https://duckduckgo.com/" }, signal: AbortSignal.timeout(8000) }
      );
      if (yanit.ok) {
        const body = await yanit.json();
        for (const aday of (body.results || []).slice(0, 4)) {
          resim = await urunDisResimIndir(aday.thumbnail || aday.image || "");
          if (!resim && aday.image && aday.image !== aday.thumbnail) resim = await urunDisResimIndir(aday.image);
          if (resim) break;
        }
      }
    }
  } catch { resim = ""; }
  if (urunInternetOnbellek.size > 40) urunInternetOnbellek.clear();
  urunInternetOnbellek.set(anahtar, resim);
  return resim;
}

async function urunInternetCommons(sorgu) {
  const yanit = await fetch(
    "https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=" + encodeURIComponent(sorgu) + "&gsrnamespace=6&gsrlimit=4&prop=imageinfo&iiprop=url|mime&iiurlwidth=320&format=json",
    { headers: { "User-Agent": "VegaRaporlama/1.2 (teklif urun)", Accept: "application/json" }, signal: AbortSignal.timeout(6000) }
  );
  if (!yanit.ok) return "";
  const body = await yanit.json();
  const sayfalar = Object.values(body?.query?.pages || {});
  for (const sayfa of sayfalar) {
    const bilgi = (sayfa.imageinfo || [])[0];
    if (!bilgi || !String(bilgi.mime || "").startsWith("image/")) continue;
    const resim = await urunInternetIndir(bilgi.thumburl || bilgi.url || "");
    if (resim) return resim;
  }
  return "";
}

async function urunInternetBul(sorgu) {
  const q = String(sorgu || "").replace(/\s+/g, " ").trim().slice(0, 120);
  if (q.length < 3) return { aciklama: "", resim: "" };
  const anahtar = q.toLocaleLowerCase("tr-TR");
  if (urunInternetOnbellek.has(anahtar)) return urunInternetOnbellek.get(anahtar);
  const basliklar = { "User-Agent": "VegaRaporlama/1.2 (teklif urun)", Accept: "application/json" };
  const gorselSoz = urunAdGorselBul(q).catch(() => "");
  let sonuc = { aciklama: "", resim: "" };
  let yedekGorsel = "";
  for (const dil of ["tr", "en"]) {
    let adaylar = [];
    try {
      const yanit = await fetch(
        "https://" + dil + ".wikipedia.org/w/api.php?action=query&list=search&srsearch=" + encodeURIComponent(q) + "&utf8=1&format=json&srlimit=3&srprop=snippet",
        { headers: basliklar, signal: AbortSignal.timeout(6000) }
      );
      if (yanit.ok) {
        const body = await yanit.json();
        adaylar = body?.query?.search || [];
      }
    } catch { adaylar = []; }
    for (const aday of adaylar) {
      if (!aday?.title) continue;
      let ozet = null;
      try {
        const yanit = await fetch(
          "https://" + dil + ".wikipedia.org/api/rest_v1/page/summary/" + encodeURIComponent(String(aday.title).replace(/ /g, "_")),
          { headers: basliklar, signal: AbortSignal.timeout(6000) }
        );
        if (yanit.ok) ozet = await yanit.json();
      } catch { ozet = null; }
      if (!ozet || ozet.type === "disambiguation") continue;
      const aciklama = urunInternetKisa(ozet.extract || "");
      if (!urunInternetIlgili(q, ozet.title || aday.title, aciklama || ozet.extract || "")) continue;
      if (aciklama) sonuc = { aciklama, resim: "" };
      if (!yedekGorsel) yedekGorsel = ozet?.thumbnail?.source || "";
      break;
    }
    if (sonuc.aciklama) break;
  }
  let resim = "";
  try { resim = await gorselSoz; } catch { resim = ""; }
  if (!resim) {
    try { resim = await urunInternetCommons(q); } catch { resim = ""; }
  }
  if (!resim && yedekGorsel) {
    try { resim = await urunInternetIndir(yedekGorsel); } catch { resim = ""; }
  }
  if (resim) sonuc = { aciklama: sonuc.aciklama, resim };
  if (urunInternetOnbellek.size > 40) urunInternetOnbellek.clear();
  urunInternetOnbellek.set(anahtar, sonuc);
  return sonuc;
}

function teklifResimKok() {
  const kok = join(uygulamaKok(), "teklif-resimler");
  mkdirSync(kok, { recursive: true });
  return kok;
}

function teklifResimAd(firma, ad) {
  const temizAd = String(ad || "").replace(/[^\w-]/g, "");
  if (!temizAd) return "";
  return `F${pad(firma)}-${temizAd}`;
}

function teklifStokKodAnahtar(kod) {
  const yazi = String(kod || "").trim().toLocaleUpperCase("tr").slice(0, 80);
  if (!yazi) return "";
  return "K" + Buffer.from(yazi, "utf8").toString("hex").slice(0, 64);
}

function teklifResimBul(firma, ad) {
  const onek = teklifResimAd(firma, ad);
  if (!onek) return "";
  const kok = teklifResimKok();
  return [".jpg", ".png", ".gif", ".webp"].map((uz) => join(kok, onek + uz)).find((yol) => existsSync(yol)) || "";
}

function teklifResimKaydet(firma, ad, buf) {
  const onek = teklifResimAd(firma, ad);
  const tur = resimTuru(buf);
  if (!onek || !tur) return "";
  const kok = teklifResimKok();
  for (const uz of [".jpg", ".png", ".gif", ".webp"]) {
    const eski = join(kok, onek + uz);
    if (existsSync(eski)) {
      try { unlinkSync(eski); } catch { /* eski resim duruyor */ }
    }
  }
  const uz = tur === "image/png" ? ".png" : tur === "image/gif" ? ".gif" : tur === "image/webp" ? ".webp" : ".jpg";
  const yol = join(kok, onek + uz);
  writeFileSync(yol, buf);
  return yol;
}

function teklifResimCoz(value) {
  const yazi = String(value || "");
  const es = /^data:image\/[a-zA-Z0-9.+-]+;base64,([A-Za-z0-9+/=\s]+)$/.exec(yazi);
  const ham = (es ? es[1] : "").replace(/\s+/g, "");
  if (!ham || ham.length > 2200000) return null;
  const buf = Buffer.from(ham, "base64");
  if (!buf.length || buf.length > 1600000 || !resimTuru(buf)) return null;
  return buf;
}

async function vegaStokResmi(firma, stok) {
  const tablo = firmaTablo(firma, "TBLSTOKLAR");
  if (!await nesneVar(tablo)) return null;
  const kolon = await kolonKumesi(tablo);
  if (!kolon.has("RESIM")) return null;
  return queryBytes(`
SET NOCOUNT ON;
SELECT CAST(RESIM AS varbinary(max))
FROM ${tablo}
WHERE IND = ${stok} AND RESIM IS NOT NULL AND DATALENGTH(RESIM) > 20;
`);
}

function teklifResimGonder(res, yol, buf) {
  const govde = buf || (yol ? readFileSync(yol) : null);
  const tur = resimTuru(govde);
  if (!govde || !tur) {
    res.writeHead(404, { "Cache-Control": "no-store" });
    res.end();
    return;
  }
  res.writeHead(200, { "Content-Type": tur, "Cache-Control": "private, max-age=120" });
  res.end(govde);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  try {
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(sayfaOku());
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/pencere") {
      gonder(res, 200, pencereOlcuOku() || { ...GIRIS_PENCERE, left: 0, top: 0, tam: false });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/pencere") {
      const body = await okuGovde(req);
      const genislik = Math.round(Number(body.genislik));
      const yukseklik = Math.round(Number(body.yukseklik));
      const left = Math.round(Number(body.left));
      const top = Math.round(Number(body.top));
      if (genislik < 320 || yukseklik < 240) return gonder(res, 400, { error: "Pencere ölçüsü yok." });
      const dosya = pencereOlcuDosya();
      mkdirSync(dirname(dosya), { recursive: true });
      writeFileSync(dosya, JSON.stringify({
        genislik,
        yukseklik,
        left: Number.isFinite(left) ? left : 0,
        top: Number.isFinite(top) ? top : 0,
        tam: body.tam === true,
      }));
      gonder(res, 200, { ok: true });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/giris-onbilgi") {
      const tercihFirma = tamSayi(url.searchParams.get("firma"));
      const onbilgi = await girisOnbilgiGetir(tercihFirma);
      gonder(res, 200, onbilgi);
      return;
    }

    if (req.method === "GET" && (
      url.pathname === "/favicon.ico"
      || url.pathname === "/expert-bilisim.ico"
      || url.pathname === "/expert-bilisim.png"
      || url.pathname === "/expert-logo.png"
      || url.pathname === "/expert-logo.jpg"
      || url.pathname === "/expert-logo-teklif.png"
      || url.pathname === "/vega-yazilim-logo.png"
    )) {
      const ad = basename(url.pathname);
      const yol = ilkVarolan([
        join(__dirname, "assets", ad),
        join(dirname(process.execPath), ad),
        join(kurulumKok(), ad),
        join(kaynakKok(), "assets", ad),
        ad === "favicon.ico" || ad === "expert-bilisim.ico" ? ikonYolu() : "",
        ad === "expert-bilisim.png" ? pngYolu() : "",
        ad.startsWith("expert-logo") && !ad.includes("teklif")
          ? ilkVarolan([
            join(__dirname, "assets", "expert-logo.png"),
            join(dirname(process.execPath), "expert-logo.png"),
            join(__dirname, "assets", "expert-logo.jpg"),
            join(dirname(process.execPath), "expert-logo.jpg"),
          ])
          : "",
      ].filter(Boolean));
      if (!yol) { res.writeHead(404); res.end(); return; }
      const tur = yol.endsWith(".png") ? "image/png" : (yol.endsWith(".jpg") || yol.endsWith(".jpeg") ? "image/jpeg" : "image/x-icon");
      res.writeHead(200, { "Content-Type": tur, "Cache-Control": "no-cache" });
      res.end(readFileSync(yol));
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/baglanti") {
      gonder(res, 200, { surum: UYGULAMA_SURUM, server: link.server, database: link.database, guncelleme: guncellemeDurumAl() });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/guncelleme") {
      gonder(res, 200, guncellemeDurumAl());
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/guncelleme") {
      const sonuc = await guncellemeKontrolEt(true);
      gonder(res, sonuc.durum === "hata" ? 400 : 200, sonuc);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/kullanicilar") {
      const rows = await query(`
SET NOCOUNT ON;
SELECT IND AS no, USERNAME AS kullanici, ISNULL(AD, N'') AS ad, ISNULL(SOYAD, N'') AS soyad,
  FIRMA AS firma, DONEM AS donem,
  CASE WHEN NULLIF(LTRIM(RTRIM(ISNULL(SIFRE, N''))), N'') IS NULL THEN 0 ELSE 1 END AS sifreVar
FROM TBLUSERS
WHERE ISNULL(USERNAME, N'') <> N''
ORDER BY USERNAME
FOR JSON PATH;
`);
      gonder(res, 200, { items: rows });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/firmalar") {
      gonder(res, 200, { items: await firmalariGetir() });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/donemler") {
      const firma = tamSayi(url.searchParams.get("firma"));
      if (!firma) return gonder(res, 400, { error: "Firma seçin." });
      gonder(res, 200, { items: await donemleriGetir(firma) });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/subeler") {
      const firma = tamSayi(url.searchParams.get("firma"));
      if (!firma) return gonder(res, 400, { error: "Firma seçin." });
      gonder(res, 200, { items: await subeleriGetir(firma) });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/giris") {
      const body = await okuGovde(req);
      const kullanici = metin(body.kullanici, 80).trim();
      const sifre = metin(body.sifre, 80);
      const firma = tamSayi(body.firma);
      const donem = tamSayi(body.donem);
      if (!kullanici) return gonder(res, 400, { error: "Kullanıcı seçin." });
      if (!firma || !donem) return gonder(res, 400, { error: "Firma ve dönem seçin." });
      const rows = await query(`
SET NOCOUNT ON;
SELECT TOP 1
  IND AS no,
  USERNAME AS kullanici,
  ISNULL(AD, N'') AS ad,
  ISNULL(SOYAD, N'') AS soyad
FROM TBLUSERS
WHERE USERNAME = N'${kullanici}'
  AND (
    NULLIF(LTRIM(RTRIM(ISNULL(SIFRE, N''))), N'') IS NULL
    OR SIFRE = N'${sifre}'
  )
FOR JSON PATH, WITHOUT_ARRAY_WRAPPER;
`);
      const user = rows[0];
      if (!user) return gonder(res, 401, { error: "Kullanıcı adı veya şifre hatalı." });
      const token = randomBytes(24).toString("hex");
      oturumlar.set(token, { no: user.no, kullanici: user.kullanici, firma, donem });
      googleBaglamYaz({ firma, donem });
      gonder(res, 200, {
        token,
        kullanici: user.kullanici,
        ad: [user.ad, user.soyad].filter(Boolean).join(" ") || user.kullanici,
        firma,
        donem,
        database: link.database,
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/stok-ozel-kod") {
      if (!oturum(req)) return gonder(res, 401, { error: "Giriş gerekli." });
      const firma = tamSayi(url.searchParams.get("firma"));
      if (!firma) return gonder(res, 400, { error: "Firma seçin." });
      const label = await nesneVar([
        firmaTablo(firma, "TBLSTOKKARTKODLABEL"),
        firmaTablo(firma, "TBLSTOKKODLABEL"),
      ]);
      const tan = await nesneVar(firmaTablo(firma, "TBLSTOKKODTAN"));
      if (!label && !tan) return gonder(res, 200, { gruplar: [] });
      const temiz = (ifade) => `REPLACE(REPLACE(REPLACE(RTRIM(ISNULL(${ifade}, N'')), N'|', N'/'), CHAR(13), N' '), CHAR(10), N' ')`;
      const parcalar = [];
      if (label) {
        parcalar.push(`SELECT CAST(CATEGORY AS varchar(4)), ${temiz("CAPTION")}, N''
FROM ${label}
WHERE CATEGORY BETWEEN 1 AND 10`);
      }
      if (tan) {
        parcalar.push(`SELECT CAST(CATEGORY AS varchar(4)), N'', ${temiz("KOD")}
FROM ${tan}
WHERE CATEGORY BETWEEN 1 AND 10 AND RTRIM(ISNULL(KOD, N'')) <> N''`);
      }
      const lines = await queryLines(`
SET NOCOUNT ON;
${parcalar.join("\nUNION ALL\n")};
`);
      const gruplar = new Map();
      for (let no = 1; no <= 10; no += 1) gruplar.set(no, { no, ad: "Özel " + no, degerler: [] });
      for (const line of lines) {
        const [kategori, ad, kod] = line.split("|").map((part) => part.trim());
        const no = Number(kategori);
        const grup = gruplar.get(no);
        if (!grup) continue;
        if (ad) grup.ad = ad;
        if (kod && !grup.degerler.includes(kod)) grup.degerler.push(kod);
      }
      for (const grup of gruplar.values()) grup.degerler.sort((a, b) => a.localeCompare(b, "tr"));
      gonder(res, 200, { gruplar: [...gruplar.values()] });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/satis-analiz") {
      if (!oturum(req)) return gonder(res, 401, { error: "Giriş gerekli." });
      const firma = tamSayi(url.searchParams.get("firma"));
      const donem = tamSayi(url.searchParams.get("donem"));
      const basHam = url.searchParams.get("bas");
      const bitHam = url.searchParams.get("bit");
      const bas = sqlTarihIfade(basHam);
      const bit = sqlTarihIfade(bitHam);
      const satir = String(url.searchParams.get("satir") || "stok").toLowerCase() === "cari" ? "cari" : "stok";
      const kolonHam = String(url.searchParams.get("kolon") || "ay").toLowerCase();
      const kolon = kolonHam === "hafta" || kolonHam === "gun" ? kolonHam : "ay";
      const q = ara(url.searchParams.get("q"));
      if (!firma || !donem || !bas || !bit) return gonder(res, 400, { error: "Firma, dönem ve tarih seçin." });
      const hareketKaynaklari = await satisHareketKaynaklari(firma, donem, basHam, bitHam, url.searchParams.get("yillar"), url.searchParams.get("firmalar"));
      const temizSql = (ifade) => `REPLACE(REPLACE(REPLACE(RTRIM(ISNULL(${ifade}, N'')), N'|', N'/'), CHAR(13), N' '), CHAR(10), N' ')`;
      const kodIfade = satir === "stok"
        ? temizSql("s.STOKKODU")
        : `CASE WHEN RTRIM(ISNULL(c.FIRMAKODU, N'')) = N'' THEN N'' ELSE ${temizSql("c.FIRMAKODU")} END`;
      const adIfade = satir === "stok"
        ? `CASE WHEN RTRIM(ISNULL(s.MALINCINSI, N'')) = N'' THEN N'(adsız stok)' ELSE ${temizSql("s.MALINCINSI")} END`
        : `CASE WHEN RTRIM(ISNULL(c.FIRMAADI, N'')) = N'' THEN N'(Cari yok)' ELSE ${temizSql("c.FIRMAADI")} END`;
      const kolonIfade = kolon === "ay"
        ? "CONVERT(varchar(7), h.TARIH, 126)"
        : kolon === "hafta"
          ? "CAST(DATEPART(year, h.TARIH) AS varchar(4)) + N'-H' + RIGHT(N'0' + CAST(DATEPART(iso_week, h.TARIH) AS varchar(2)), 2)"
          : "CONVERT(varchar(10), h.TARIH, 23)";
      const ozelFiltre = [];
      for (let no = 1; no <= 10; no += 1) {
        const deger = metin(url.searchParams.get("ok" + no), 80).trim();
        if (deger) ozelFiltre.push(`AND RTRIM(ISNULL(s.KOD${no}, N'')) = N'${deger}'`);
      }
      const like = q ? `%${q}%` : "";
      const arama = !like
        ? ""
        : satir === "stok"
          ? `AND (s.STOKKODU COLLATE Latin1_General_CI_AI LIKE N'${like}' OR s.MALINCINSI COLLATE Latin1_General_CI_AI LIKE N'${like}')`
          : `AND (ISNULL(c.FIRMAKODU, N'') COLLATE Latin1_General_CI_AI LIKE N'${like}' OR ISNULL(c.FIRMAADI, N'') COLLATE Latin1_General_CI_AI LIKE N'${like}')`;
      const miktarIfade = `SUM(CASE WHEN h.IZAHAT IN (23, 87, 102) THEN -ISNULL(h.CIKAN, 0) ELSE ISNULL(h.CIKAN, 0) END)`;
      const satisMiktarIfade = `SUM(CASE WHEN h.IZAHAT IN (21, 33, 85, 89) THEN ISNULL(h.CIKAN, 0) ELSE 0 END)`;
      const iadeMiktarIfade = `SUM(CASE WHEN h.IZAHAT IN (23, 87, 102) THEN ISNULL(h.CIKAN, 0) ELSE 0 END)`;
      const satisIfade = `SUM(CASE WHEN h.IZAHAT IN (21, 33, 85, 89) THEN ISNULL(h.TUTAR, 0) ELSE 0 END)`;
      const iadeIfade = `SUM(CASE WHEN h.IZAHAT IN (23, 87, 102) THEN ISNULL(h.TUTAR, 0) ELSE 0 END)`;
      const netIfade = `(${satisIfade} - ${iadeIfade})`;
      const olcu = String(url.searchParams.get("olcu") || "tutar").toLowerCase() === "miktar" ? "miktar" : "tutar";
      const ozetSatisIfade = olcu === "miktar" ? satisMiktarIfade : satisIfade;
      const ozetIadeIfade = olcu === "miktar" ? iadeMiktarIfade : iadeIfade;
      const ozetNetIfade = olcu === "miktar" ? miktarIfade : netIfade;
      if (String(url.searchParams.get("dokum") || "") === "1") {
        const ortakWhere = `
WHERE ISNULL(s.DELETED, 0) = 0
  AND h.IZAHAT IN (21, 23, 33, 85, 87, 89, 102)
  AND h.TARIH >= ${bas}
  AND h.TARIH < DATEADD(day, 1, ${bit})
  ${arama}
  ${ozelFiltre.join("\n  ")}`;
        const ozetSatir = await satisSorguBirlestir(hareketKaynaklari, (kaynak) => `
SET NOCOUNT ON;
SELECT
  CAST(${ozetSatisIfade} AS decimal(18, 2)),
  CAST(${ozetIadeIfade} AS decimal(18, 2)),
  CAST(${ozetNetIfade} AS decimal(18, 2)),
  CAST(COUNT(*) AS varchar(12))
FROM ${kaynak.tablo} h
JOIN ${kaynak.stok} s ON s.IND = h.STOKNO
LEFT JOIN ${kaynak.cari} c ON c.IND = h.FIRMANO
${ortakWhere};
`);
        let satisYazi = 0;
        let iadeYazi = 0;
        let ciroYazi = 0;
        let adetYazi = 0;
        for (const line of ozetSatir) {
          const [satisParca, iadeParca, ciroParca, adetParca] = line.split("|").map((part) => part.trim());
          satisYazi += Number(satisParca) || 0;
          iadeYazi += Number(iadeParca) || 0;
          ciroYazi += Number(ciroParca) || 0;
          adetYazi += Number(adetParca) || 0;
        }
        const hareketSatir = await satisSorguBirlestir(hareketKaynaklari, (kaynak) => `
SET NOCOUNT ON;
SELECT TOP 4000
  CONVERT(varchar(10), h.TARIH, 104),
  CAST(ISNULL(h.IZAHAT, 0) AS varchar(6)),
  REPLACE(REPLACE(REPLACE(RTRIM(ISNULL(h.EVRAKNO, N'')), N'|', N'/'), CHAR(13), N' '), CHAR(10), N' '),
  CAST(ISNULL(h.BELGENO, 0) AS varchar(12)),
  REPLACE(REPLACE(REPLACE(RTRIM(ISNULL(s.STOKKODU, N'')), N'|', N'/'), CHAR(13), N' '), CHAR(10), N' '),
  REPLACE(REPLACE(REPLACE(RTRIM(ISNULL(s.MALINCINSI, N'')), N'|', N'/'), CHAR(13), N' '), CHAR(10), N' '),
  REPLACE(REPLACE(REPLACE(RTRIM(ISNULL(c.FIRMAKODU, N'')), N'|', N'/'), CHAR(13), N' '), CHAR(10), N' '),
  REPLACE(REPLACE(REPLACE(RTRIM(ISNULL(c.FIRMAADI, N'')), N'|', N'/'), CHAR(13), N' '), CHAR(10), N' '),
  CAST(CASE WHEN h.IZAHAT IN (23, 87, 102) THEN -ISNULL(h.CIKAN, 0) ELSE ISNULL(h.CIKAN, 0) END AS decimal(18, 2)),
  CAST(CASE WHEN h.IZAHAT IN (23, 87, 102) THEN -ISNULL(h.TUTAR, 0) ELSE ISNULL(h.TUTAR, 0) END AS decimal(18, 2))
FROM ${kaynak.tablo} h
JOIN ${kaynak.stok} s ON s.IND = h.STOKNO
LEFT JOIN ${kaynak.cari} c ON c.IND = h.FIRMANO
${ortakWhere}
ORDER BY h.TARIH, h.IND;
`);
        const hareketler = hareketSatir.map((line) => {
          const [tarih, izahat, evrakNo, belgeNo, stokKod, stokAd, cariKod, cariAd, miktar, tutar] = line.split("|").map((part) => part.trim());
          return {
            tarih,
            izahat: Number(izahat) || 0,
            evrakNo,
            belgeNo: Number(belgeNo) || 0,
            stokKod,
            stokAd,
            cariKod,
            cariAd,
            miktar: Number(miktar) || 0,
            tutar: Number(tutar) || 0,
          };
        });
        const adet = Number(adetYazi) || hareketler.length;
        gonder(res, 200, {
          hareketler,
          adet,
          kesik: adet > hareketler.length,
          satis: Number(satisYazi) || 0,
          iade: Number(iadeYazi) || 0,
          ciro: Number(ciroYazi) || 0,
        });
        return;
      }
      const lines = await satisSorguBirlestir(hareketKaynaklari, (kaynak) => `
SET NOCOUNT ON;
SELECT
  CAST(${Number(kaynak.firma) || 0} AS varchar(8)),
  ${kodIfade},
  ${adIfade},
  ${kolonIfade},
  CAST(${miktarIfade} AS decimal(18, 2)),
  CAST(${satisMiktarIfade} AS decimal(18, 2)),
  CAST(${iadeMiktarIfade} AS decimal(18, 2)),
  CAST(${satisIfade} AS decimal(18, 2)),
  CAST(${iadeIfade} AS decimal(18, 2)),
  CAST(${netIfade} AS decimal(18, 2))
FROM ${kaynak.tablo} h
JOIN ${kaynak.stok} s ON s.IND = h.STOKNO
LEFT JOIN ${kaynak.cari} c ON c.IND = h.FIRMANO
WHERE ISNULL(s.DELETED, 0) = 0
  AND h.IZAHAT IN (21, 23, 33, 85, 87, 89, 102)
  AND h.TARIH >= ${bas}
  AND h.TARIH < DATEADD(day, 1, ${bit})
  ${arama}
  ${ozelFiltre.join("\n  ")}
GROUP BY ${kodIfade}, ${adIfade}, ${kolonIfade}
HAVING ABS(${netIfade}) > 0.004 OR ABS(${miktarIfade}) > 0.004 OR ABS(${satisIfade}) > 0.004 OR ABS(${iadeIfade}) > 0.004 OR ABS(${satisMiktarIfade}) > 0.004 OR ABS(${iadeMiktarIfade}) > 0.004;
`);
      const hucreler = new Map();
      const kolonlar = new Map();
      const firmaAylik = new Map();
      for (const line of lines) {
        const [firmaNoYazi, kod, ad, anahtar, netMiktar, satisMiktar, iadeMiktar, satis, iade, net] = line.split("|").map((part) => part.trim());
        if (!anahtar) continue;
        if (!kolonlar.has(anahtar)) kolonlar.set(anahtar, satisAnalizEtiket(kolon, anahtar));
        const kim = (kod || "") + "\n" + (ad || "");
        if (!hucreler.has(kim)) hucreler.set(kim, { kod: kod || "", ad: ad || kod || "—", hucre: new Map(), miktar: 0, satis: 0, iade: 0, toplam: 0 });
        const row = hucreler.get(kim);
        const hucreSayi = olcu === "miktar" ? (Number(netMiktar) || 0) : (Number(net) || 0);
        const satisSayi = olcu === "miktar" ? (Number(satisMiktar) || 0) : (Number(satis) || 0);
        const iadeSayi = olcu === "miktar" ? (Number(iadeMiktar) || 0) : (Number(iade) || 0);
        row.hucre.set(anahtar, (row.hucre.get(anahtar) || 0) + hucreSayi);
        row.miktar += Number(netMiktar) || 0;
        row.satis += satisSayi;
        row.iade += iadeSayi;
        row.toplam += hucreSayi;
        const firmaNo = Number(firmaNoYazi) || 0;
        if (!firmaAylik.has(anahtar)) firmaAylik.set(anahtar, new Map());
        const aylik = firmaAylik.get(anahtar);
        aylik.set(firmaNo, (aylik.get(firmaNo) || 0) + hucreSayi);
      }
      if (kolon === "ay") {
        const ayParca = (yazi) => {
          const parca = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(String(yazi || "").trim());
          return parca ? { y: Number(parca[3]), a: Number(parca[2]) } : null;
        };
        const basAy = ayParca(url.searchParams.get("bas"));
        const bitAy = ayParca(url.searchParams.get("bit"));
        if (basAy && bitAy) {
          let yil = basAy.y;
          let ay = basAy.a;
          let koruma = 0;
          while ((yil < bitAy.y || (yil === bitAy.y && ay <= bitAy.a)) && koruma < 96) {
            const anahtar = String(yil) + "-" + String(ay).padStart(2, "0");
            if (!kolonlar.has(anahtar)) kolonlar.set(anahtar, satisAnalizEtiket("ay", anahtar));
            ay += 1;
            if (ay > 12) {
              ay = 1;
              yil += 1;
            }
            koruma += 1;
          }
        }
      }
      const kolonListe = [...kolonlar.keys()].sort().map((anahtar) => ({ anahtar, etiket: kolonlar.get(anahtar) }));
      const sirali = [...hucreler.values()].sort((a, b) => b.toplam - a.toplam || a.ad.localeCompare(b.ad, "tr"));
      const sinir = 40;
      const gorunen = sirali.slice(0, sinir);
      const kalan = sirali.slice(sinir);
      if (kalan.length) {
        const diger = { kod: "", ad: "Diğer", hucre: new Map(), miktar: 0, satis: 0, iade: 0, toplam: 0 };
        for (const row of kalan) {
          diger.miktar += row.miktar;
          diger.satis += row.satis;
          diger.iade += row.iade;
          diger.toplam += row.toplam;
          for (const [anahtar, tutar] of row.hucre) diger.hucre.set(anahtar, (diger.hucre.get(anahtar) || 0) + tutar);
        }
        gorunen.push(diger);
      }
      const satirlar = gorunen.map((row) => ({
        kod: row.kod,
        ad: row.ad,
        hucreler: kolonListe.map((kol) => row.hucre.get(kol.anahtar) || 0),
        miktar: row.miktar,
        satis: row.satis,
        iade: row.iade,
        toplam: row.toplam,
      }));
      const firmaNolar = [];
      for (const kaynak of hareketKaynaklari) {
        const no = Number(kaynak.firma) || 0;
        if (no && !firmaNolar.includes(no)) firmaNolar.push(no);
      }
      const firmaAdlari = new Map();
      if (firmaNolar.length > 1) {
        for (const firmaKayit of await firmalariGetir()) {
          firmaAdlari.set(firmaKayit.no, firmaKayit.kisaAd || firmaKayit.ad || firmaKayit.kod || ("Firma " + firmaKayit.no));
        }
      }
      const firmaListe = firmaNolar.map((no) => ({ no, ad: firmaAdlari.get(no) || ("Firma " + no) }));
      const zaman = kolonListe.map((kol, index) => ({
        anahtar: kol.anahtar,
        etiket: kol.etiket,
        ciro: satirlar.reduce((sum, row) => sum + (row.hucreler[index] || 0), 0),
        firmalar: firmaListe.length > 1
          ? firmaListe.map((firmaKayit) => ({
            no: firmaKayit.no,
            ad: firmaKayit.ad,
            ciro: firmaAylik.get(kol.anahtar)?.get(firmaKayit.no) || 0,
          }))
          : undefined,
      }));
      const toplamSatis = sirali.reduce((sum, row) => sum + row.satis, 0);
      const toplamIade = sirali.reduce((sum, row) => sum + row.iade, 0);
      const toplamCiro = sirali.reduce((sum, row) => sum + row.toplam, 0);
      const toplamMiktar = sirali.reduce((sum, row) => sum + row.miktar, 0);
      gonder(res, 200, {
        kolonlar: kolonListe,
        satirlar,
        zaman,
        miktar: toplamMiktar,
        satis: toplamSatis,
        iade: toplamIade,
        ciro: toplamCiro,
        satir,
        kolon,
        olcu,
        adet: sirali.length,
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/ciro") {
      if (!oturum(req)) return gonder(res, 401, { error: "Giriş gerekli." });
      const firma = tamSayi(url.searchParams.get("firma"));
      const donem = tamSayi(url.searchParams.get("donem"));
      const q = ara(url.searchParams.get("q"));
      const bas = sqlTarihIfade(url.searchParams.get("bas"));
      const bit = sqlTarihIfade(url.searchParams.get("bit"));
      if (!firma || !donem || !bas || !bit) return gonder(res, 400, { error: "Firma, dönem ve tarih seçin." });
      const like = q ? `%${q}%` : "";
      const ozelFiltre = [];
      for (let no = 1; no <= 10; no += 1) {
        const deger = metin(url.searchParams.get("ok" + no), 80).trim();
        if (deger) ozelFiltre.push(`AND RTRIM(ISNULL(s.KOD${no}, N'')) = N'${deger}'`);
      }
      const grupHam = String(url.searchParams.get("grup") || "stok").trim().toLowerCase();
      const grupNo = Number(grupHam);
      const ozelGrup = Number.isInteger(grupNo) && grupNo >= 1 && grupNo <= 10;
      const seriHam = String(url.searchParams.get("seri") || "gun").trim().toLowerCase();
      const seri = seriHam === "ay" || seriHam === "hafta" || seriHam === "yil" ? seriHam : "gun";
      const sadeceOzet = String(url.searchParams.get("ozet") || "") === "1";
      const hareket = donemTablo(firma, donem, "TBLSTOKHAREKETLERI");
      const stok = firmaTablo(firma, "TBLSTOKLAR");
      const arama = like
        ? `AND (s.STOKKODU COLLATE Latin1_General_CI_AI LIKE N'${like}' OR s.MALINCINSI COLLATE Latin1_General_CI_AI LIKE N'${like}')`
        : "";
      const miktarIfade = `SUM(CASE WHEN h.IZAHAT IN (23, 87, 102) THEN -ISNULL(h.CIKAN, 0) ELSE ISNULL(h.CIKAN, 0) END)`;
      const satisIfade = `SUM(CASE WHEN h.IZAHAT IN (21, 33, 85, 89) THEN ISNULL(h.TUTAR, 0) ELSE 0 END)`;
      const iadeIfade = `SUM(CASE WHEN h.IZAHAT IN (23, 87, 102) THEN ISNULL(h.TUTAR, 0) ELSE 0 END)`;
      const netIfade = `(${satisIfade} - ${iadeIfade})`;
      const ortakWhere = `
WHERE ISNULL(s.DELETED, 0) = 0
  AND h.IZAHAT IN (21, 23, 33, 85, 87, 89, 102)
  AND h.TARIH >= ${bas}
  AND h.TARIH < DATEADD(day, 1, ${bit})
  ${arama}
  ${ozelFiltre.join("\n  ")}`;
      const ozelIfade = ozelGrup
        ? `CASE WHEN RTRIM(ISNULL(s.KOD${grupNo}, N'')) = N'' THEN N'(boş)' ELSE REPLACE(REPLACE(REPLACE(RTRIM(ISNULL(s.KOD${grupNo}, N'')), N'|', N'/'), CHAR(13), N' '), CHAR(10), N' ') END`
        : "";
      const kodAlan = ozelGrup
        ? ozelIfade
        : `REPLACE(REPLACE(REPLACE(s.STOKKODU, N'|', N'/'), CHAR(13), N' '), CHAR(10), N' ')`;
      const adAlan = ozelGrup
        ? ozelIfade
        : `REPLACE(REPLACE(REPLACE(ISNULL(s.MALINCINSI, N''), N'|', N'/'), CHAR(13), N' '), CHAR(10), N' ')`;
      const grupSql = ozelGrup ? ozelIfade : `${kodAlan}, ${adAlan}`;
      let items = [];
      if (!sadeceOzet) {
        const lines = await queryLines(`
SET NOCOUNT ON;
SELECT
  ${kodAlan},
  ${adAlan},
  CAST(${miktarIfade} AS decimal(18, 2)),
  CAST(${satisIfade} AS decimal(18, 2)),
  CAST(${iadeIfade} AS decimal(18, 2)),
  CAST(${netIfade} AS decimal(18, 2))
FROM ${hareket} h
JOIN ${stok} s ON s.IND = h.STOKNO
${ortakWhere}
GROUP BY ${grupSql}
HAVING ABS(${netIfade}) > 0.004 OR ABS(${miktarIfade}) > 0.004 OR ABS(${satisIfade}) > 0.004 OR ABS(${iadeIfade}) > 0.004
ORDER BY ${netIfade} DESC, 1;
`);
        items = lines.map((line) => {
          const [kod, ad, miktar, satis, iade, net] = line.split("|").map((part) => part.trim());
          const miktarSayi = Number(miktar) || 0;
          const satisSayi = Number(satis) || 0;
          const iadeSayi = Number(iade) || 0;
          const netSayi = Number(net) || 0;
          return {
            kod: ozelGrup && !kod ? "(boş)" : kod,
            ad: ad || (ozelGrup ? "(boş)" : ""),
            miktar: miktarSayi,
            satis: satisSayi,
            iade: iadeSayi,
            ciro: netSayi,
            birim: miktarSayi ? netSayi / miktarSayi : 0,
          };
        });
      }
      let zamanIfade = "CONVERT(varchar(10), h.TARIH, 104)";
      let zamanSira = "MIN(h.TARIH)";
      if (seri === "ay") {
        zamanIfade = "CONVERT(varchar(7), h.TARIH, 126)";
        zamanSira = "MIN(DATEADD(month, DATEDIFF(month, 0, h.TARIH), 0))";
      } else if (seri === "hafta") {
        zamanIfade = `CAST(DATEPART(year, h.TARIH) AS varchar(4)) + N'-H' + RIGHT(N'0' + CAST(DATEPART(iso_week, h.TARIH) AS varchar(2)), 2)`;
        zamanSira = "MIN(DATEADD(day, 1 - DATEPART(weekday, h.TARIH), h.TARIH))";
      } else if (seri === "yil") {
        zamanIfade = "CAST(DATEPART(year, h.TARIH) AS varchar(4))";
        zamanSira = "MIN(DATEADD(year, DATEDIFF(year, 0, h.TARIH), 0))";
      }
      const zamanSatir = await queryLines(`
SET NOCOUNT ON;
SELECT
  ${zamanIfade},
  CAST(${miktarIfade} AS decimal(18, 2)),
  CAST(${satisIfade} AS decimal(18, 2)),
  CAST(${iadeIfade} AS decimal(18, 2)),
  CAST(${netIfade} AS decimal(18, 2))
FROM ${hareket} h
JOIN ${stok} s ON s.IND = h.STOKNO
${ortakWhere}
GROUP BY ${zamanIfade}
ORDER BY ${zamanSira};
`);
      const zaman = zamanSatir.map((line) => {
        const [etiket, miktar, satis, iade, net] = line.split("|").map((part) => part.trim());
        return {
          etiket,
          miktar: Number(miktar) || 0,
          satis: Number(satis) || 0,
          iade: Number(iade) || 0,
          ciro: Number(net) || 0,
        };
      });
      const kaynak = items.length ? items : zaman;
      const toplamSatis = kaynak.reduce((sum, row) => sum + Number(row.satis || 0), 0);
      const toplamIade = kaynak.reduce((sum, row) => sum + Number(row.iade || 0), 0);
      const toplamCiro = kaynak.reduce((sum, row) => sum + Number(row.ciro || 0), 0);
      const toplamMiktar = kaynak.reduce((sum, row) => sum + Number(row.miktar || 0), 0);
      gonder(res, 200, {
        items,
        zaman,
        miktar: toplamMiktar,
        satis: toplamSatis,
        iade: toplamIade,
        ciro: toplamCiro,
        grup: ozelGrup ? String(grupNo) : "stok",
        seri,
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/siparis-ihtiyac") {
      if (!oturum(req)) return gonder(res, 401, { error: "Giriş gerekli." });
      const firma = tamSayi(url.searchParams.get("firma"));
      const donem = tamSayi(url.searchParams.get("donem"));
      const basHam = url.searchParams.get("bas");
      const bitHam = url.searchParams.get("bit");
      const bas = sqlTarihIfade(basHam);
      const bit = sqlTarihIfade(bitHam);
      const hedef = tamSayi(url.searchParams.get("hedef"), 365) || 30;
      const basP = tarihParca(basHam);
      const bitP = tarihParca(bitHam);
      if (!firma || !donem || !bas || !bit || !basP || !bitP) return gonder(res, 400, { error: "Firma, dönem ve tarih seçin." });
      const gun = Math.max(1, Math.round((Date.UTC(bitP.yil, bitP.ay - 1, bitP.gun) - Date.UTC(basP.yil, basP.ay - 1, basP.gun)) / 86400000) + 1);
      const q = ara(url.searchParams.get("q"));
      const like = q ? `%${q}%` : "";
      const tipler = String(url.searchParams.get("tip") ?? "0,100")
        .split(",")
        .map((parca) => Number(parca.trim()))
        .filter((no) => Number.isInteger(no) && no >= 0 && no <= 1000);
      const hareket = donemTablo(firma, donem, "TBLSTOKHAREKETLERI");
      const stok = firmaTablo(firma, "TBLSTOKLAR");
      if (!await nesneVar(hareket) || !await nesneVar(stok)) return gonder(res, 200, { items: [], gun, hedef, tipler: [] });
      const arama = like
        ? `AND (s.STOKKODU COLLATE Latin1_General_CI_AI LIKE N'${like}' OR s.MALINCINSI COLLATE Latin1_General_CI_AI LIKE N'${like}')`
        : "";
      const tipFiltre = tipler.length ? `AND ISNULL(s.STOKTIPI, 0) IN (${tipler.join(", ")})` : "";
      const lines = await queryLines(`
SET NOCOUNT ON;
WITH env AS (
  SELECT h.STOKNO, SUM(ISNULL(h.GIREN, 0) - ISNULL(h.CIKAN, 0)) AS miktar
  FROM ${hareket} h
  WHERE h.TARIH < DATEADD(day, 1, ${bit})
  GROUP BY h.STOKNO
),
satis AS (
  SELECT h.STOKNO,
    SUM(CASE
      WHEN h.IZAHAT IN (21, 33, 85, 89) THEN ISNULL(h.CIKAN, 0)
      WHEN h.IZAHAT IN (23, 87, 102) THEN -ISNULL(h.CIKAN, 0)
      ELSE 0
    END) AS miktar
  FROM ${hareket} h
  WHERE h.IZAHAT IN (21, 23, 33, 85, 87, 89, 102)
    AND h.TARIH >= ${bas}
    AND h.TARIH < DATEADD(day, 1, ${bit})
  GROUP BY h.STOKNO
)
SELECT
  REPLACE(REPLACE(REPLACE(s.STOKKODU, N'|', N'/'), CHAR(13), N' '), CHAR(10), N' '),
  REPLACE(REPLACE(REPLACE(ISNULL(s.MALINCINSI, N''), N'|', N'/'), CHAR(13), N' '), CHAR(10), N' '),
  CAST(ISNULL(e.miktar, 0) AS decimal(18, 2)),
  CAST(ISNULL(t.miktar, 0) AS decimal(18, 2)),
  CAST(ISNULL(t.miktar, 0) / ${gun}.0 AS decimal(18, 4)),
  CAST(CASE WHEN ISNULL(t.miktar, 0) > 0 THEN ISNULL(e.miktar, 0) / (ISNULL(t.miktar, 0) / ${gun}.0) ELSE 0 END AS decimal(18, 1)),
  CAST(((ISNULL(t.miktar, 0) / ${gun}.0) * ${hedef}) - ISNULL(e.miktar, 0) AS decimal(18, 2))
FROM ${stok} s
JOIN satis t ON t.STOKNO = s.IND
LEFT JOIN env e ON e.STOKNO = s.IND
WHERE ISNULL(s.DELETED, 0) = 0
  AND ISNULL(t.miktar, 0) > 0.004
  AND ((ISNULL(t.miktar, 0) / ${gun}.0) * ${hedef}) - ISNULL(e.miktar, 0) > 0.004
  ${arama}
  ${tipFiltre}
ORDER BY
  CASE WHEN ISNULL(t.miktar, 0) > 0 THEN ISNULL(e.miktar, 0) / (ISNULL(t.miktar, 0) / ${gun}.0) ELSE 0 END,
  ((ISNULL(t.miktar, 0) / ${gun}.0) * ${hedef}) - ISNULL(e.miktar, 0) DESC;
`);
      const items = lines.map((line) => {
        const [kod, ad, envanter, satilan, hiz, gunYeter, siparis] = line.split("|").map((part) => part.trim());
        return {
          kod,
          ad,
          envanter: Number(String(envanter).replace(",", ".")) || 0,
          satilan: Number(String(satilan).replace(",", ".")) || 0,
          hiz: Number(String(hiz).replace(",", ".")) || 0,
          gunYeter: Number(String(gunYeter).replace(",", ".")) || 0,
          siparis: Number(String(siparis).replace(",", ".")) || 0,
        };
      });
      let tipListe = [{ kod: 0, ad: "Emtia" }, { kod: 100, ad: "Seri Numaralı Ticari Mal" }];
      try {
        const tipSatirlari = await queryLines(`
SET NOCOUNT ON;
SELECT CAST(ISNULL(STOKTIPI, 0) AS varchar(8)), dbo.STOKTIPITOSTR(ISNULL(STOKTIPI, 0))
FROM ${stok}
WHERE ISNULL(DELETED, 0) = 0
GROUP BY ISNULL(STOKTIPI, 0)
ORDER BY ISNULL(STOKTIPI, 0);
`);
        if (tipSatirlari.length) {
          tipListe = tipSatirlari.map((line) => {
            const [kod, ad] = line.split("|").map((part) => part.trim());
            return { kod: Number(kod) || 0, ad: ad || String(kod) };
          });
        }
      } catch { /* tip adları yoksa varsayılan liste kalır */ }
      gonder(res, 200, { items, gun, hedef, tipler: tipListe });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/maliyet-deger") {
      if (!oturum(req)) return gonder(res, 401, { error: "Giriş gerekli." });
      const firma = tamSayi(url.searchParams.get("firma"));
      const donem = tamSayi(url.searchParams.get("donem"));
      const q = ara(url.searchParams.get("q"));
      const bas = sqlTarihIfade(url.searchParams.get("bas"));
      const bit = sqlTarihIfade(url.searchParams.get("bit"));
      const ekstreHam = sqlTarihIfade(url.searchParams.get("ekstre")) || bit;
      if (!firma || !donem || !bas || !bit || !ekstreHam) return gonder(res, 400, { error: "Firma, dönem ve tarih seçin." });
      const like = q ? `%${q}%` : "";
      const ozelFiltre = [];
      for (let no = 1; no <= 10; no += 1) {
        const deger = metin(url.searchParams.get("ok" + no), 80).trim();
        if (deger) ozelFiltre.push(`AND s.KOD${no} = N'${deger}'`);
      }
      const hareket = donemTablo(firma, donem, "TBLSTOKHAREKETLERI");
      const stok = firmaTablo(firma, "TBLSTOKLAR");
      const arama = like
        ? `AND (s.STOKKODU COLLATE Latin1_General_CI_AI LIKE N'${like}' OR s.MALINCINSI COLLATE Latin1_General_CI_AI LIKE N'${like}')`
        : "";
      const lines = await queryLines(`
SET NOCOUNT ON;
WITH env AS (
  SELECT h.STOKNO,
    SUM(ISNULL(h.GIREN, 0) - ISNULL(h.CIKAN, 0)) AS miktar
  FROM ${hareket} h
  WHERE h.TARIH < DATEADD(day, 1, ${ekstreHam})
  GROUP BY h.STOKNO
)
SELECT
  REPLACE(REPLACE(REPLACE(s.STOKKODU, N'|', N'/'), CHAR(13), N' '), CHAR(10), N' '),
  REPLACE(REPLACE(REPLACE(ISNULL(s.MALINCINSI, N''), N'|', N'/'), CHAR(13), N' '), CHAR(10), N' '),
  CAST(ISNULL(e.miktar, 0) AS decimal(18, 2)),
  CAST(ISNULL(s.MALIYET, 0) AS decimal(18, 4)),
  CAST(ISNULL(e.miktar, 0) * ISNULL(s.MALIYET, 0) AS decimal(18, 2)),
  CAST(ISNULL(s.ALISFIYATI, 0) AS decimal(18, 4))
FROM ${stok} s
JOIN env e ON e.STOKNO = s.IND
WHERE ISNULL(s.DELETED, 0) = 0
  AND ABS(ISNULL(e.miktar, 0)) > 0.004
  ${arama}
  ${ozelFiltre.join("\n  ")}
ORDER BY ABS(ISNULL(e.miktar, 0) * ISNULL(s.MALIYET, 0)) DESC, s.STOKKODU;
`);
      const items = lines.map((line) => {
        const [kod, ad, miktar, maliyet, deger, alis] = line.split("|").map((part) => part.trim());
        return {
          kod,
          ad,
          miktar: Number(miktar),
          maliyet: Number(maliyet),
          deger: Number(deger),
          alis: Number(alis),
        };
      });
      gonder(res, 200, {
        items,
        miktar: items.reduce((sum, row) => sum + Number(row.miktar || 0), 0),
        deger: items.reduce((sum, row) => sum + Number(row.deger || 0), 0),
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/stok-ekstre") {
      if (!oturum(req)) return gonder(res, 401, { error: "Giriş gerekli." });
      const firma = tamSayi(url.searchParams.get("firma"));
      const donem = tamSayi(url.searchParams.get("donem"));
      const kod = metin(url.searchParams.get("kod"), 200).trim();
      const bas = sqlTarihIfade(url.searchParams.get("bas"));
      const bit = sqlTarihIfade(url.searchParams.get("bit"));
      if (!firma || !donem || !kod || !bas || !bit) return gonder(res, 400, { error: "Stok ve tarih seçin." });
      const hareket = donemTablo(firma, donem, "TBLSTOKHAREKETLERI");
      const stok = firmaTablo(firma, "TBLSTOKLAR");
      const lines = await queryLines(`
SET NOCOUNT ON;
SELECT
  CONVERT(varchar(10), h.TARIH, 104),
  CAST(ISNULL(h.IZAHAT, 0) AS varchar(6)),
  REPLACE(REPLACE(REPLACE(RTRIM(ISNULL(h.EVRAKNO, N'')), N'|', N'/'), CHAR(13), N' '), CHAR(10), N' '),
  CAST(ISNULL(h.GIREN, 0) AS decimal(18, 2)),
  CAST(ISNULL(h.CIKAN, 0) AS decimal(18, 2)),
  CAST(ISNULL(h.BIRIMMALIYET, 0) AS decimal(18, 4)),
  CAST(ISNULL(h.BELGENO, 0) AS varchar(12))
FROM ${hareket} h
JOIN ${stok} s ON s.IND = h.STOKNO
WHERE s.STOKKODU COLLATE Latin1_General_CI_AI = N'${kod}'
  AND h.TARIH >= ${bas}
  AND h.TARIH < DATEADD(day, 1, ${bit})
ORDER BY h.TARIH, h.IND;
`);
      let bakiye = 0;
      const items = lines.map((line) => {
        const [tarih, izahat, evrakNo, giren, cikan, birimMaliyet, belgeNo] = line.split("|").map((part) => part.trim());
        const g = Number(giren) || 0;
        const c = Number(cikan) || 0;
        bakiye += g - c;
        return {
          tarih,
          izahat: Number(izahat) || 0,
          evrakNo,
          giren: g,
          cikan: c,
          bakiye,
          birimMaliyet: Number(birimMaliyet) || 0,
          belgeNo: Number(belgeNo) || 0,
        };
      });
      gonder(res, 200, { kod, items });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/karlilik") {
      if (!oturum(req)) return gonder(res, 401, { error: "Giriş gerekli." });
      const firma = tamSayi(url.searchParams.get("firma"));
      const donem = tamSayi(url.searchParams.get("donem"));
      const q = ara(url.searchParams.get("q"));
      if (!firma || !donem) return gonder(res, 400, { error: "Firma ve dönem seçin." });
      const like = q ? `%${q}%` : "";
      const ozelFiltre = [];
      for (let no = 1; no <= 10; no += 1) {
        const deger = metin(url.searchParams.get("ok" + no), 80).trim();
        if (deger) ozelFiltre.push(`AND s.KOD${no} = N'${deger}'`);
      }
      const ozelSql = ozelFiltre.join("\n  ");
      const hareket = donemTablo(firma, donem, "TBLSTOKHAREKETLERI");
      const stok = firmaTablo(firma, "TBLSTOKLAR");
      const filtre = like
        ? `AND (s.STOKKODU COLLATE Latin1_General_CI_AI LIKE N'${like}' OR s.MALINCINSI COLLATE Latin1_General_CI_AI LIKE N'${like}')`
        : "";
      const envanterIfade = like
        ? "CASE WHEN e.envanter IS NULL THEN ISNULL(s.KALAN, 0) ELSE e.envanter END"
        : "ISNULL(e.envanter, 0)";
      const kaynak = like
        ? `FROM ${stok} s
LEFT JOIN satis x ON x.STOKNO = s.IND
LEFT JOIN env e ON e.STOKNO = s.IND
WHERE ISNULL(s.DELETED, 0) = 0
  AND (
    ISNULL(x.miktar, 0) <> 0 OR ISNULL(x.tutar, 0) <> 0 OR ISNULL(s.KALAN, 0) <> 0
  )
  ${filtre}
  ${ozelSql}`
        : `FROM satis x
JOIN ${stok} s ON s.IND = x.STOKNO
LEFT JOIN env e ON e.STOKNO = s.IND
WHERE ISNULL(s.DELETED, 0) = 0
  AND (ISNULL(x.miktar, 0) <> 0 OR ISNULL(x.tutar, 0) <> 0)
  ${ozelSql}`;
      const lines = await queryLines(`
SET NOCOUNT ON;
WITH satis AS (
  SELECT h.STOKNO,
    SUM(ISNULL(h.CIKAN, 0)) AS miktar,
    SUM(ISNULL(h.TUTAR, 0)) AS tutar
  FROM ${hareket} h
  WHERE h.IZAHAT IN (21, 23, 33)
  GROUP BY h.STOKNO
),
env AS (
  SELECT h.STOKNO,
    SUM(ISNULL(h.GIREN, 0) - ISNULL(h.CIKAN, 0)) AS envanter
  FROM ${hareket} h
  GROUP BY h.STOKNO
)
SELECT
  REPLACE(REPLACE(REPLACE(s.STOKKODU, N'|', N'/'), CHAR(13), N' '), CHAR(10), N' '),
  REPLACE(REPLACE(REPLACE(ISNULL(s.MALINCINSI, N''), N'|', N'/'), CHAR(13), N' '), CHAR(10), N' '),
  CAST(ISNULL(x.miktar, 0) AS decimal(18, 2)),
  CAST(${envanterIfade} AS decimal(18, 2)),
  CAST(ISNULL(x.tutar, 0) AS decimal(18, 2)),
  CAST(ISNULL(x.miktar, 0) * ISNULL(s.MALIYET, 0) AS decimal(18, 2)),
  CAST(ISNULL(x.tutar, 0) - ISNULL(x.miktar, 0) * ISNULL(s.MALIYET, 0) AS decimal(18, 2))
${kaynak}
ORDER BY s.STOKKODU;
`);
      const rows = lines.map((line) => {
        const [kod, ad, miktar, envanter, tutar, maliyet, kar] = line.split("|").map((part) => part.trim());
        return {
          kod,
          ad,
          miktar: Number(miktar),
          envanter: Number(envanter),
          tutar: Number(tutar),
          maliyet: Number(maliyet),
          kar: Number(kar),
        };
      });
      const tutar = rows.reduce((sum, row) => sum + Number(row.tutar || 0), 0);
      const maliyet = rows.reduce((sum, row) => sum + Number(row.maliyet || 0), 0);
      const kar = rows.reduce((sum, row) => sum + Number(row.kar || 0), 0);
      gonder(res, 200, {
        items: rows,
        tutar,
        maliyet,
        kar,
        ortalama: maliyet ? (kar / maliyet) * 100 : 0,
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/cari-ozel-kod") {
      if (!oturum(req)) return gonder(res, 401, { error: "Giriş gerekli." });
      const firma = tamSayi(url.searchParams.get("firma"));
      if (!firma) return gonder(res, 400, { error: "Firma seçin." });
      const label = await nesneVar([
        firmaTablo(firma, "TBLCARIKARTKODLABEL"),
        firmaTablo(firma, "TBLCARIKODLABEL"),
      ]);
      const tan = await nesneVar(firmaTablo(firma, "TBLCARIKODTAN"));
      if (!label && !tan) return gonder(res, 200, { gruplar: [] });
      const temiz = (ifade) => `REPLACE(REPLACE(REPLACE(RTRIM(ISNULL(${ifade}, N'')), N'|', N'/'), CHAR(13), N' '), CHAR(10), N' ')`;
      const parcalar = [];
      if (label) {
        parcalar.push(`SELECT CAST(CATEGORY - 100 AS varchar(4)), ${temiz("CAPTION")}, N''
FROM ${label}
WHERE CATEGORY BETWEEN 101 AND 107`);
      }
      if (tan) {
        parcalar.push(`SELECT CAST(CATEGORY AS varchar(4)), N'', ${temiz("KOD")}
FROM ${tan}
WHERE CATEGORY BETWEEN 1 AND 7 AND RTRIM(ISNULL(KOD, N'')) <> N''`);
      }
      const lines = await queryLines(`
SET NOCOUNT ON;
${parcalar.join("\nUNION ALL\n")};
`);
      const gruplar = new Map();
      for (let no = 1; no <= 7; no += 1) gruplar.set(no, { no, ad: "Özel " + no, degerler: [] });
      for (const line of lines) {
        const [kategori, ad, kod] = line.split("|").map((part) => part.trim());
        const no = Number(kategori);
        const grup = gruplar.get(no);
        if (!grup) continue;
        if (ad) grup.ad = ad;
        if (kod && !grup.degerler.includes(kod)) grup.degerler.push(kod);
      }
      for (const grup of gruplar.values()) grup.degerler.sort((a, b) => a.localeCompare(b, "tr"));
      gonder(res, 200, { gruplar: [...gruplar.values()] });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/cari-pasif") {
      const kim = oturum(req);
      if (!kim) return gonder(res, 401, { error: "Giriş gerekli." });
      const body = await okuGovde(req);
      const kodlar = [...new Set((Array.isArray(body.kodlar) ? body.kodlar : [])
        .map((kod) => metin(kod, 80).trim())
        .filter(Boolean))].slice(0, 400);
      if (!kodlar.length) return gonder(res, 400, { error: "Cari seçin." });
      const cari = firmaTablo(kim.firma, "TBLCARI");
      const kolon = await kolonKumesi(cari);
      if (!kolon.has("STATUS")) return gonder(res, 400, { error: "Cari durum kolonu yok." });
      const sonuc = await queryLines(`
SET NOCOUNT ON;
UPDATE ${cari}
SET STATUS = 2
WHERE ISNULL(DELETED, 0) = 0
  AND FIRMAKODU IN (${kodlar.map((kod) => `N'${kod}'`).join(", ")});
SELECT N'n', CAST(@@ROWCOUNT AS varchar(12));
`);
      const adet = Number((sonuc[0] || "").split("|")[1]) || kodlar.length;
      gonder(res, 200, { adet });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/cari-aylik") {
      const kim = oturum(req);
      if (!kim) return gonder(res, 401, { error: "Giriş gerekli." });
      const kod = metin(url.searchParams.get("kod"), 80).trim();
      if (!kod) return gonder(res, 400, { error: "Cari seçin." });
      const hareket = donemTablo(kim.firma, kim.donem, "TBLCARIHAREKETLERI");
      const cari = firmaTablo(kim.firma, "TBLCARI");
      const yilSatir = await queryLines(`
SET NOCOUNT ON;
SELECT N'y', CAST(ISNULL(DONEM, 0) AS varchar(8))
FROM TBLDONEM
WHERE FIND = ${kim.firma} AND IND = ${kim.donem};
`);
      const yil = Number((yilSatir[0] || "").split("|")[1]) || 0;
      const lines = await queryLines(`
SET NOCOUNT ON;
SELECT
  CAST(MONTH(h.TARIH) AS varchar(2)),
  CAST(SUM(ISNULL(h.BORC, 0)) AS decimal(18, 2)),
  CAST(SUM(ISNULL(h.ALACAK, 0)) AS decimal(18, 2))
FROM ${hareket} h
JOIN ${cari} c ON c.IND = h.FIRMANO
WHERE c.FIRMAKODU COLLATE Turkish_CI_AS = N'${kod}'
GROUP BY MONTH(h.TARIH);
`);
      const harita = new Map(lines.map((line) => {
        const [ay, borc, alacak] = line.split("|").map((part) => part.trim());
        return [Number(ay), { borc: Number(borc) || 0, alacak: Number(alacak) || 0 }];
      }));
      const aylar = [];
      for (let ay = 1; ay <= 12; ay += 1) {
        const bulunan = harita.get(ay) || { borc: 0, alacak: 0 };
        aylar.push({ ay, borc: bulunan.borc, alacak: bulunan.alacak });
      }
      gonder(res, 200, { yil, kod, aylar });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/acik-borc") {
      if (!oturum(req)) return gonder(res, 401, { error: "Giriş gerekli." });
      const firma = tamSayi(url.searchParams.get("firma"));
      const donem = tamSayi(url.searchParams.get("donem"));
      const q = ara(url.searchParams.get("q"));
      const ok3 = metin(url.searchParams.get("ok3"), 80).trim();
      const kalanZorunlu = url.searchParams.get("kalan") === "0" ? 0 : 1;
      const ozet = url.searchParams.get("ozet") === "1" ? 1 : 0;
      if (!firma || !donem) return gonder(res, 400, { error: "Firma ve dönem seçin." });
      const sp = donemTablo(firma, donem, "ACIKBORCALACAKYASLANDIRMA");
      const spVar = await queryLines(`
SET NOCOUNT ON;
SELECT N'v', ROUTINE_NAME
FROM INFORMATION_SCHEMA.ROUTINES
WHERE ROUTINE_TYPE = N'PROCEDURE' AND ROUTINE_NAME = N'${sp.replace(/[^\w]/g, "")}';
`);
      if (!spVar.length) return gonder(res, 404, { error: "Açık borç alacak prosedürü bulunamadı." });
      const tarihYazi = (ham) => {
        const yazi = String(ham || "").trim();
        if (!yazi || yazi.toUpperCase() === "NULL") return "";
        const iso = yazi.match(/^(\d{4})-(\d{2})-(\d{2})/);
        if (iso) return iso[3] + "." + iso[2] + "." + iso[1];
        const tr = yazi.match(/^(\d{2})\.(\d{2})\.(\d{4})/);
        if (tr) return tr[0];
        return yazi.slice(0, 10);
      };
      const sayi = (ham) => {
        const n = Number(String(ham || "").replace(",", "."));
        return Number.isFinite(n) ? n : 0;
      };
      const lines = await queryLines(`
SET NOCOUNT ON;
EXEC ${sp} @XAYLIKFAIZ=0, @XRT=${ozet}, @XKALAN=${kalanZorunlu}, @XOZELKOD3=N'${ok3.replace(/'/g, "''")}';
`);
      const like = q ? q.toLocaleLowerCase("tr") : "";
      const ham = [];
      for (const line of lines) {
        const p = line.split("|");
        if (p.length < 18) continue;
        const kod = (p[4] || "").trim();
        const ad = (p[5] || "").trim();
        if (like && !(`${kod} ${ad} ${p[8] || ""}`).toLocaleLowerCase("tr").includes(like)) continue;
        ham.push({
          kod,
          ad,
          tarih: tarihYazi(p[6]),
          belgeNo: Number(p[7]) || 0,
          evrakNo: (p[8] || "").trim(),
          izahat: Number(p[9]) || 0,
          vade: tarihYazi(p[10]),
          tutar: sayi(p[11]),
          odenen: sayi(p[12]),
          kalan: sayi(p[13]),
          odm: sayi(p[14]),
          gec: sayi(p[15]),
          pb: (p[17] || "").trim() || "TL",
          g10: sayi(p[26]),
          g30: sayi(p[27]),
          g45: sayi(p[28]),
          g60: sayi(p[29]),
          g90: sayi(p[30]),
        });
      }
      const birlestir = new Map();
      for (const row of ham) {
        const anahtar = `${row.kod}|${row.pb}`;
        const onceki = birlestir.get(anahtar);
        if (!onceki) {
          birlestir.set(anahtar, { ...row, adet: 1, secKalan: Math.abs(row.kalan), evrakAsil: row.evrakNo });
          continue;
        }
        onceki.tutar += row.tutar;
        onceki.odenen += row.odenen;
        onceki.kalan += row.kalan;
        onceki.g10 += row.g10;
        onceki.g30 += row.g30;
        onceki.g45 += row.g45;
        onceki.g60 += row.g60;
        onceki.g90 += row.g90;
        onceki.odm = (onceki.odm * onceki.adet + row.odm) / (onceki.adet + 1);
        onceki.gec = (onceki.gec * onceki.adet + row.gec) / (onceki.adet + 1);
        onceki.adet += 1;
        if (Math.abs(row.kalan) >= onceki.secKalan) {
          onceki.belgeNo = row.belgeNo;
          onceki.evrakAsil = row.evrakNo;
          onceki.izahat = row.izahat;
          onceki.tarih = row.tarih;
          onceki.vade = row.vade;
          onceki.secKalan = Math.abs(row.kalan);
        }
      }
      const items = [...birlestir.values()].map((row) => {
        const { adet, secKalan, evrakAsil, ...rest } = row;
        return {
          ...rest,
          evrakNo: adet > 1 ? `${adet} belge` : evrakAsil,
        };
      });
      gonder(res, 200, {
        items,
        tutar: items.reduce((sum, row) => sum + row.tutar, 0),
        odenen: items.reduce((sum, row) => sum + row.odenen, 0),
        kalan: items.reduce((sum, row) => sum + row.kalan, 0),
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/cari-bakiye") {
      if (!oturum(req)) return gonder(res, 401, { error: "Giriş gerekli." });
      const firma = tamSayi(url.searchParams.get("firma"));
      const donem = tamSayi(url.searchParams.get("donem"));
      const q = ara(url.searchParams.get("q"));
      if (!firma || !donem) return gonder(res, 400, { error: "Firma ve dönem seçin." });
      const like = q ? `%${q}%` : "";
      const hareketsiz = url.searchParams.get("hareketsiz") === "1";
      const yazi = (ifade) => `REPLACE(REPLACE(REPLACE(${ifade}, N'|', N'/'), CHAR(13), N' '), CHAR(10), N' ')`;
      const arama = (kodAlan, adAlan) => like
        ? `(${kodAlan} COLLATE Latin1_General_CI_AI LIKE N'${like}' OR ${adAlan} COLLATE Latin1_General_CI_AI LIKE N'${like}')`
        : "";
      const ozelKodlar = (yaz) => {
        const liste = [];
        for (let no = 1; no <= 7; no += 1) {
          const deger = metin(url.searchParams.get("ok" + no), 80).trim();
          if (!deger) continue;
          const kosul = yaz(no, deger);
          if (kosul) liste.push(kosul);
        }
        return liste;
      };
      const cariBakiyesiniHareketten = async () => {
        const hareket = donemTablo(firma, donem, "TBLCARIHAREKETLERI");
        const cari = firmaTablo(firma, "TBLCARI");
        const hareketKolon = await kolonKumesi(hareket);
        const cariKolon = await kolonKumesi(cari);
        const borc = hareketKolon.has("TLBORC") ? "h.TLBORC" : "h.BORC";
        const alacak = hareketKolon.has("TLALACAK") ? "h.TLALACAK" : "h.ALACAK";
        const pbIfade = cariKolon.has("PARABIRIMI") ? "ISNULL(c.PARABIRIMI, N'TL')" : "N'TL'";
        const tipIfade = cariKolon.has("FIRMATIPI")
          ? "CASE c.FIRMATIPI WHEN 1 THEN N'A' WHEN 2 THEN N'S' WHEN 3 THEN N'AS' ELSE RTRIM(CAST(ISNULL(c.FIRMATIPI, 0) AS nvarchar(10))) END"
          : "N''";
        const grup = ["c.FIRMAKODU", "c.FIRMAADI"];
        if (cariKolon.has("PARABIRIMI")) grup.push("c.PARABIRIMI");
        if (cariKolon.has("FIRMATIPI")) grup.push("c.FIRMATIPI");
        const kosullar = [];
        if (cariKolon.has("DELETED")) kosullar.push("ISNULL(c.DELETED, 0) = 0");
        const bulunan = arama("c.FIRMAKODU", "c.FIRMAADI");
        if (bulunan) kosullar.push(bulunan);
        kosullar.push(...ozelKodlar((no, deger) => cariKolon.has("KOD" + no) ? `RTRIM(c.KOD${no}) = N'${deger}'` : ""));
        const filtre = kosullar.length ? `WHERE ${kosullar.join(" AND ")}` : "";
        return queryLines(`
SET NOCOUNT ON;
SELECT
  ${yazi("ISNULL(c.FIRMAKODU, N'')")},
  ${yazi("ISNULL(c.FIRMAADI, N'')")},
  ${yazi(pbIfade)},
  ${yazi(tipIfade)},
  CASE WHEN ABS(SUM(ISNULL(${borc}, 0)) - SUM(ISNULL(${alacak}, 0))) > 0.004 THEN N'Bakiye Verenler' ELSE N'Bakiyesizler' END,
  CAST(SUM(ISNULL(${borc}, 0)) AS decimal(18, 2)),
  CAST(SUM(ISNULL(${alacak}, 0)) AS decimal(18, 2)),
  CAST(SUM(ISNULL(${borc}, 0)) - SUM(ISNULL(${alacak}, 0)) AS decimal(18, 2))
FROM ${cari} c
JOIN ${hareket} h ON h.FIRMANO = c.IND
${filtre}
GROUP BY ${grup.join(", ")}
ORDER BY c.FIRMAKODU;
`);
      };
      let lines;
      if (hareketsiz) {
        const ozet = firmaTablo(firma, "TBLCARI");
        const hareket = donemTablo(firma, donem, "TBLCARIHAREKETLERI");
        const kolon = await kolonKumesi(ozet);
        const hareketKolon = await kolonKumesi(hareket);
        const kosullar = ["ISNULL(c.DELETED, 0) = 0"];
        const bulunan = arama("c.FIRMAKODU", "c.FIRMAADI");
        if (bulunan) kosullar.push(bulunan);
        kosullar.push(...ozelKodlar((no, deger) => kolon.has("KOD" + no) ? `RTRIM(c.KOD${no}) = N'${deger}'` : ""));
        const tablolar = await cariHareketTablolari(firma);
        const sonKaynak = tablolar.length
          ? tablolar.map((tablo) => `SELECT FIRMANO, TARIH FROM ${tablo}`).join(" UNION ALL ")
          : "SELECT CAST(NULL AS int) FIRMANO, CAST(NULL AS datetime) TARIH WHERE 1 = 0";
        const kartIfade = kolon.has("STATUS")
          ? "CASE WHEN ISNULL(c.STATUS, 1) = 2 THEN N'Pasif' ELSE N'Aktif' END"
          : "N'Aktif'";
        const borcAlan = hareketKolon.has("TLBORC") ? "h.TLBORC" : "h.BORC";
        const alacakAlan = hareketKolon.has("TLALACAK") ? "h.TLALACAK" : "h.ALACAK";
        lines = await queryLines(`
SET NOCOUNT ON;
WITH son AS (
  SELECT FIRMANO, MAX(TARIH) AS SON
  FROM (${sonKaynak}) x
  GROUP BY FIRMANO
),
donemOzet AS (
  SELECT
    h.FIRMANO,
    SUM(ISNULL(${borcAlan}, 0)) AS BORC,
    SUM(ISNULL(${alacakAlan}, 0)) AS ALACAK
  FROM ${hareket} h
  GROUP BY h.FIRMANO
)
SELECT
  ${yazi("ISNULL(c.FIRMAKODU, N'')")},
  ${yazi("ISNULL(c.FIRMAADI, N'')")},
  ${yazi("ISNULL(c.PARABIRIMI, N'')")},
  ${yazi("CASE c.FIRMATIPI WHEN 1 THEN N'A' WHEN 2 THEN N'S' WHEN 3 THEN N'AS' ELSE RTRIM(CAST(ISNULL(c.FIRMATIPI, 0) AS nvarchar(10))) END")},
  CASE WHEN ABS(ISNULL(d.BORC, 0) - ISNULL(d.ALACAK, 0)) > 0.004 THEN N'Bakiye Verenler' ELSE N'Bakiyesizler' END,
  CAST(ISNULL(d.BORC, 0) AS decimal(18, 2)),
  CAST(ISNULL(d.ALACAK, 0) AS decimal(18, 2)),
  CAST(ISNULL(d.BORC, 0) - ISNULL(d.ALACAK, 0) AS decimal(18, 2)),
  ${kartIfade},
  ISNULL(CONVERT(varchar(10), s.SON, 104), N'-'),
  CASE WHEN s.SON IS NULL THEN N'-' ELSE CAST(DATEDIFF(day, s.SON, GETDATE()) AS varchar(12)) END
FROM ${ozet} c
LEFT JOIN son s ON s.FIRMANO = c.IND
LEFT JOIN donemOzet d ON d.FIRMANO = c.IND
WHERE ${kosullar.join(" AND ")}
ORDER BY CASE WHEN s.SON IS NULL THEN 1 ELSE 0 END DESC, DATEDIFF(day, s.SON, GETDATE()) DESC, c.FIRMAKODU;
`);
      } else {
        let ozetVar = false;
        try { ozetVar = Boolean(await nesneVar(donemTablo(firma, donem, "VARESCARIHAREKETOZET"))); } catch { ozetVar = false; }
        if (ozetVar) {
          const ozet = donemTablo(firma, donem, "VARESCARIHAREKETOZET");
          const kosullar = [];
          const bulunan = arama("v.FIRMAKODU", "v.FIRMAADI");
          if (bulunan) kosullar.push(bulunan);
          kosullar.push(...ozelKodlar((no, deger) => `v.CARIKOD${no} = N'${deger}'`));
          const filtre = kosullar.length ? `WHERE ${kosullar.join(" AND ")}` : "";
          try {
            lines = await queryLines(`
SET NOCOUNT ON;
SELECT
  ${yazi("ISNULL(v.FIRMAKODU, N'')")},
  ${yazi("ISNULL(v.FIRMAADI, N'')")},
  ${yazi("ISNULL(c.PARABIRIMI, N'TL')")},
  ${yazi("RTRIM(ISNULL(v.FIRMATIPI, N''))")},
  CASE WHEN ABS(SUM(ISNULL(v.TLBAKIYE, 0))) > 0.004 THEN N'Bakiye Verenler' ELSE N'Bakiyesizler' END,
  CAST(SUM(ISNULL(v.TLBORC, 0)) AS decimal(18, 2)),
  CAST(SUM(ISNULL(v.TLALACAK, 0)) AS decimal(18, 2)),
  CAST(SUM(ISNULL(v.TLBAKIYE, 0)) AS decimal(18, 2))
FROM ${ozet} v
LEFT JOIN ${firmaTablo(firma, "TBLCARI")} c
  ON c.IND = v.FIRMANO
${filtre}
GROUP BY v.FIRMAKODU, v.FIRMAADI, v.FIRMATIPI, c.PARABIRIMI
ORDER BY v.FIRMAKODU;
`);
          } catch (error) {
            const mesaj = String(error && error.message || "");
            if (!/Invalid object name|Geçersiz nesne/i.test(mesaj)) throw error;
            lines = null;
          }
        }
        if (!lines) lines = await cariBakiyesiniHareketten();
      }
      const items = lines.map((line) => {
        const [kod, ad, pb, tip, durum, borc, alacak, bakiye, kart, sonHareket, gun] = line.split("|").map((part) => part.trim());
        const [gunYazi, ayYazi, yilYazi] = String(sonHareket || "").split(".");
        const sonSayi = Number(yilYazi) * 10000 + Number(ayYazi) * 100 + Number(gunYazi);
        return {
          kod,
          ad,
          pb,
          tip,
          durum,
          borc: Number(borc),
          alacak: Number(alacak),
          bakiye: Number(bakiye),
          kart: kart || "",
          sonHareket: sonHareket && sonHareket !== "-" ? sonHareket : "",
          sonSayi: Number.isFinite(sonSayi) && sonHareket !== "-" ? sonSayi : 0,
          gun: gun === "" || gun == null || gun === "-" ? null : Number(gun),
        };
      });
      gonder(res, 200, { items });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/cari-hareket") {
      if (!oturum(req)) return gonder(res, 401, { error: "Giriş gerekli." });
      const firma = tamSayi(url.searchParams.get("firma"));
      const donem = tamSayi(url.searchParams.get("donem"));
      const kod = metin(url.searchParams.get("kod"), 200).trim();
      const pb = metin(url.searchParams.get("pb"), 20).trim();
      if (!firma || !donem || !kod) return gonder(res, 400, { error: "Cari seçin." });
      const hareket = donemTablo(firma, donem, "TBLCARIHAREKETLERI");
      const cari = firmaTablo(firma, "TBLCARI");
      const hareketKolon = await kolonKumesi(hareket);
      const pbSql = pb && hareketKolon.has("PARABIRIMI")
        ? `AND RTRIM(ISNULL(h.PARABIRIMI, N'')) = N'${pb}'`
        : "";
      const aciklama = notIfadesi(hareketKolon, "h", ["ALTNOT", "ACIKLAMA", "NOT"]);
      const pbAlan = hareketKolon.has("PARABIRIMI") ? "RTRIM(ISNULL(h.PARABIRIMI, N''))" : "N''";
      const sube = duzYazi(hareketKolon, "h", ["OZELKOD1", "OZELKOD"]);
      const lines = await queryLines(`
SET NOCOUNT ON;
SELECT
  h.IZAHAT,
  CONVERT(varchar(10), h.TARIH, 104),
  REPLACE(REPLACE(REPLACE(RTRIM(ISNULL(h.EVRAKNO, N'')), N'|', N'/'), CHAR(13), N' '), CHAR(10), N' '),
  ${aciklama},
  CAST(ISNULL(h.BORC, 0) AS decimal(18, 2)),
  CAST(ISNULL(h.ALACAK, 0) AS decimal(18, 2)),
  ${pbAlan},
  CAST(ISNULL(h.LN, 0) AS int),
  ${sube}
FROM ${hareket} h
JOIN ${cari} c ON c.IND = h.FIRMANO
WHERE c.FIRMAKODU COLLATE Turkish_CI_AS = N'${kod}'
  ${pbSql}
ORDER BY ${hareketKolon.has("SIRALAMATARIHI") ? "ISNULL(h.SIRALAMATARIHI, h.TARIH)" : "h.TARIH"}, h.IND;
`);
      const kalemler = new Map();
      const kalemEkle = (anahtar, kalem) => {
        const liste = kalemler.get(anahtar) || [];
        liste.push(kalem);
        kalemler.set(anahtar, liste);
      };
      const yaziAlan = (ifade) => `REPLACE(REPLACE(REPLACE(RTRIM(ISNULL(${ifade}, N'')), N'|', N'/'), CHAR(13), N' '), CHAR(10), N' ')`;
      try {
        const stokHareket = donemTablo(firma, donem, "TBLSTOKHAREKETLERI");
        const stok = firmaTablo(firma, "TBLSTOKLAR");
        const stokSatir = await queryLines(`
SET NOCOUNT ON;
SELECT
  h.IZAHAT,
  CAST(ISNULL(h.BELGENO, 0) AS int),
  CAST(CASE WHEN ISNULL(h.GIREN, 0) <> 0 THEN h.GIREN ELSE ISNULL(h.CIKAN, 0) END AS decimal(18, 2)),
  ${yaziAlan("s.MALINCINSI")},
  CAST(ISNULL(h.TUTAR, 0) AS decimal(18, 2))
FROM ${stokHareket} h
JOIN ${stok} s ON s.IND = h.STOKNO
JOIN ${cari} c ON c.IND = h.FIRMANO
WHERE c.FIRMAKODU COLLATE Turkish_CI_AS = N'${kod}'
ORDER BY h.BELGENO, h.IND;
`);
        for (const line of stokSatir) {
          const [izahat, belgeNo, miktar, ad, tutar] = line.split("|").map((part) => part.trim());
          kalemEkle(izahat + "|" + belgeNo, { miktar: Number(miktar), ad, tutar: Number(tutar) });
        }
      } catch { /* stok satırı yok */ }
      for (const tabloAd of ["TBLSATFAT", "TBLPSATFAT"]) {
        try {
          const baslik = donemTablo(firma, donem, tabloAd + "BASLIK");
          const detay = donemTablo(firma, donem, tabloAd + "HAREKET");
          const faturaSatir = await queryLines(`
SET NOCOUNT ON;
SELECT
  CAST(b.IND AS int),
  CAST(ISNULL(h.MIKTAR, 0) AS decimal(18, 2)),
  ${yaziAlan("h.MALINCINSI")},
  CAST(ISNULL(h.GERCEKTOPLAM, 0) AS decimal(18, 2))
FROM ${detay} h
JOIN ${baslik} b ON b.IND = h.EVRAKNO
JOIN ${cari} c ON c.IND = b.FIRMANO
WHERE c.FIRMAKODU COLLATE Turkish_CI_AS = N'${kod}'
ORDER BY b.IND, h.SATIRNO, h.IND;
`);
          for (const line of faturaSatir) {
            const [belgeNo, miktar, ad, tutar] = line.split("|").map((part) => part.trim());
            kalemEkle("fatura|" + tabloAd + "|" + belgeNo, { miktar: Number(miktar), ad, tutar: Number(tutar) });
          }
        } catch { /* fatura satırı yok */ }
      }
      for (const baslikAd of ["TBLCARGIRBASLIK", "TBLCARCIKBASLIK"]) {
        try {
          const baslik = donemTablo(firma, donem, baslikAd);
          const detay = donemTablo(firma, donem, baslikAd.replace("BASLIK", "HAREKET"));
          const cekSatir = await queryLines(`
SET NOCOUNT ON;
SELECT
  CAST(b.IND AS int),
  CAST(ISNULL(h.IZAHAT, 0) AS int),
  ${yaziAlan("CAST(h.ACIKLAMA AS nvarchar(180))")},
  CONVERT(varchar(10), h.VADE, 104),
  CAST(ISNULL(h.TUTAR, 0) AS decimal(18, 2))
FROM ${detay} h
JOIN ${baslik} b ON RTRIM(ISNULL(h.EVRAKNO, N'')) = CAST(b.IND AS nvarchar(20))
JOIN ${cari} c ON c.IND = b.FIRMANO
WHERE c.FIRMAKODU COLLATE Turkish_CI_AS = N'${kod}'
ORDER BY b.IND, h.IND;
`);
          for (const line of cekSatir) {
            const [belgeNo, tur, ad, vade, tutar] = line.split("|").map((part) => part.trim());
            kalemEkle("cek|" + belgeNo, { miktar: 0, ad, vade, tutar: Number(tutar), tur: Number(tur) || 0 });
          }
        } catch { /* çek satırı yok */ }
      }
      let firmaNo = 0;
      try {
        const noSatir = await queryLines(`
SET NOCOUNT ON;
SELECT CAST(IND AS varchar(12)) + N'|1'
FROM ${cari}
WHERE FIRMAKODU COLLATE Turkish_CI_AS = N'${kod}';
`);
        firmaNo = noSatir.length ? Number(noSatir[0].split("|")[0]) || 0 : 0;
      } catch { /* firma no yok */ }
      const items = lines.map((line) => {
        const [izahat, tarih, evrakNo, aciklamaYazi, borc, alacak, paraBirimi, belgeNo, ozelKod] = line.split("|").map((part) => part.trim());
        const anahtar = izahat + "|" + (Number(belgeNo) || 0);
        const stokKalem = kalemler.get(anahtar) || [];
        const cekKalem = kalemler.get("cek|" + (Number(belgeNo) || 0)) || [];
        const faturaTablo = [21, 23].includes(Number(izahat))
          ? "TBLSATFAT"
          : ([85, 87].includes(Number(izahat)) ? "TBLPSATFAT" : "");
        const faturaKalem = faturaTablo
          ? (kalemler.get("fatura|" + faturaTablo + "|" + (Number(belgeNo) || 0)) || [])
          : [];
        return {
          izahat: Number(izahat),
          tarih,
          evrakNo,
          aciklama: aciklamaYazi,
          ozelKod: ozelKod || "",
          borc: Number(borc),
          alacak: Number(alacak),
          pb: paraBirimi,
          belgeNo: Number(belgeNo) || 0,
          kalemler: stokKalem.length ? stokKalem : (faturaKalem.length ? faturaKalem : cekKalem),
          gorseller: [],
        };
      });
      try {
        const uidListe = [];
        for (const baslikAd of ["TBLCARGIRBASLIK", "TBLCARCIKBASLIK"]) {
          const baslikTablo = donemTablo(firma, donem, baslikAd);
          const uidSatir = await queryLines(`
SET NOCOUNT ON;
SELECT
  CAST(b.IND AS varchar(12)),
  UPPER(REPLACE(REPLACE(RTRIM(CAST(b.UID AS nvarchar(40))), N'{', N''), N'}', N''))
FROM ${baslikTablo} b
JOIN ${cari} c ON c.IND = b.FIRMANO
WHERE c.FIRMAKODU COLLATE Turkish_CI_AS = N'${kod}'
  AND b.UID IS NOT NULL;
`);
          uidListe.push(...uidSatir);
        }
        const dokumanSatir = await queryLines(`
SET NOCOUNT ON;
SELECT
  CAST(Id AS varchar(12)),
  UPPER(REPLACE(REPLACE(RTRIM(OwnerGuid), N'{', N''), N'}', N'')),
  RTRIM(REPLACE(Name, N'|', N'/'))
FROM VegaDocuments.dbo.Documents
WHERE ISNULL(Deleted, 0) = 0;
`);
        const guidGorsel = new Map();
        for (const line of dokumanSatir) {
          const [id, guid, ad] = line.split("|").map((part) => part.trim());
          if (!guid) continue;
          const liste = guidGorsel.get(guid) || [];
          liste.push({ id: Number(id), ad });
          guidGorsel.set(guid, liste);
        }
        const indGorsel = new Map();
        for (const line of uidListe) {
          const [ind, guid] = line.split("|").map((part) => part.trim());
          const dosyalar = guidGorsel.get(guid);
          if (dosyalar) indGorsel.set(Number(ind), dosyalar);
        }
        for (const item of items) {
          item.gorseller = indGorsel.get(item.belgeNo) || [];
        }
      } catch { /* belge görseli yok */ }
      let telefon = "";
      let telefonlar = [];
      let smsGonder = false;
      try {
        const cariKolon = await kolonKumesi(cari);
        const smsAlan = cariKolon.has("SMSGONDERILSIN") ? "SMSGONDERILSIN"
          : cariKolon.has("SMSGONDER") ? "SMSGONDER" : "";
        const smsIfade = smsAlan
          ? `CASE WHEN ISNULL(CAST(${smsAlan} AS int), 0) = 1 OR UPPER(LTRIM(RTRIM(CAST(${smsAlan} AS nvarchar(10))))) IN (N'1', N'TRUE', N'EVET', N'E') THEN 1 ELSE 0 END`
          : "0";
        const telSatir = await queryLines(`
SET NOCOUNT ON;
SELECT
  REPLACE(REPLACE(REPLACE(RTRIM(ISNULL(YGSM, N'')), N'|', N'/'), CHAR(13), N' '), CHAR(10), N' '),
  REPLACE(REPLACE(REPLACE(RTRIM(ISNULL(TELEFON1, N'')), N'|', N'/'), CHAR(13), N' '), CHAR(10), N' '),
  REPLACE(REPLACE(REPLACE(RTRIM(ISNULL(TELEFON2, N'')), N'|', N'/'), CHAR(13), N' '), CHAR(10), N' '),
  REPLACE(REPLACE(REPLACE(RTRIM(ISNULL(TELEFON3, N'')), N'|', N'/'), CHAR(13), N' '), CHAR(10), N' '),
  ${smsIfade}
FROM ${cari}
WHERE FIRMAKODU COLLATE Turkish_CI_AS = N'${kod}';
`);
        const parca = telSatir.length ? telSatir[0].split("|").map((part) => part.trim()) : [];
        smsGonder = parca[4] === "1";
        const gorulen = new Set();
        telefonlar = parca.slice(1, 4).map(telefonNorm).filter((no) => {
          if (no.length < 12 || no.length > 15 || gorulen.has(no)) return false;
          gorulen.add(no);
          return true;
        });
        telefon = telefonlar[0] || "";
      } catch { /* telefon alanı yok */ }
      gonder(res, 200, { kod, telefon, telefonlar, smsGonder, firmaNo, items });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/whatsapp") {
      if (!oturum(req)) return gonder(res, 401, { error: "Giriş gerekli." });
      gonder(res, 200, whatsappDurum());
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/whatsapp/baslat") {
      if (!oturum(req)) return gonder(res, 401, { error: "Giriş gerekli." });
      gonder(res, 200, await whatsappBagla());
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/whatsapp/cikis") {
      if (!oturum(req)) return gonder(res, 401, { error: "Giriş gerekli." });
      gonder(res, 200, await whatsappCikis());
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/fatura-gorunum") {
      if (!oturum(req)) return gonder(res, 401, { error: "Giriş gerekli." });
      const firma = tamSayi(url.searchParams.get("firma"));
      const donem = tamSayi(url.searchParams.get("donem"));
      const no = String(url.searchParams.get("no") || "").trim().toUpperCase();
      if (!firma || !donem || !/^[A-Z0-9][A-Z0-9-]{2,39}$/.test(no)) {
        return gonder(res, 400, { error: "Fatura seçin." });
      }
      let html = "";
      try { html = await faturaGorunumHtml(firma, donem, no); } catch { html = ""; }
      if (!html) return gonder(res, 404, { error: "Fatura görseli yok." });
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "private, max-age=60" });
      res.end(html);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/dokuman") {
      if (!oturum(req)) return gonder(res, 401, { error: "Giriş gerekli." });
      const id = tamSayi(url.searchParams.get("id"), 100000000);
      if (!id) return gonder(res, 400, { error: "Belge görseli yok." });
      const satir = await queryLines(`
SET NOCOUNT ON;
SELECT RTRIM(LocalFileName), RTRIM(REPLACE(Name, N'|', N'/'))
FROM VegaDocuments.dbo.Documents
WHERE Id = ${id} AND ISNULL(Deleted, 0) = 0;
`);
      if (!satir.length) return gonder(res, 404, { error: "Belge görseli yok." });
      const [dosya, ad] = satir[0].split("|").map((part) => part.trim());
      if (!/^[0-9a-f-]{36}$/i.test(dosya)) return gonder(res, 404, { error: "Belge görseli yok." });
      const yol = ["C:\\ArcTos\\Vega.Service\\Documents", "C:\\ArcTos\\Bin\\Documents"]
        .map((kok) => join(kok, dosya))
        .find((aday) => existsSync(aday));
      if (!yol) return gonder(res, 404, { error: "Belge görseli yok." });
      const uzanti = String(ad || "").toLowerCase().split(".").pop();
      const turlar = { pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp", tif: "image/tiff", tiff: "image/tiff" };
      res.writeHead(200, {
        "Content-Type": turlar[uzanti] || "application/octet-stream",
        "Cache-Control": "private, max-age=300",
      });
      res.end(readFileSync(yol));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/pdf") {
      if (!oturum(req)) return gonder(res, 401, { error: "Giriş gerekli." });
      const body = await okuGovde(req);
      const html = String(body.html || "");
      if (html.length < 40 || html.length > 2000000) return gonder(res, 400, { error: "Rapor hazırlanamadı." });
      const pdf = await htmlPdf(html);
      const ad = String(body.dosyaAdi || "hesap-ekstresi.pdf").replace(/[\\/:*?"<>|]/g, "").slice(0, 80) || "hesap-ekstresi.pdf";
      res.writeHead(200, {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${ad.toLowerCase().endsWith(".pdf") ? ad : ad + ".pdf"}"`,
        "Cache-Control": "no-store",
      });
      res.end(pdf);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/whatsapp-gonder") {
      if (!oturum(req)) return gonder(res, 401, { error: "Giriş gerekli." });
      if (wa.durum !== "bagli") return gonder(res, 400, { error: "Sağ üstteki Ayarlar'dan telefonu bağlayın." });
      const body = await okuGovde(req);
      const gelen = Array.isArray(body.telefonlar) ? body.telefonlar : [body.telefon];
      const gorulen = new Set();
      const numaralar = gelen.map(telefonNorm).filter((no) => {
        if (no.length < 12 || no.length > 15 || gorulen.has(no)) return false;
        gorulen.add(no);
        return true;
      });
      const html = String(body.html || "");
      const ozet = String(body.ozet || "").trim().slice(0, 1000);
      const dosyaAdi = String(body.dosyaAdi || "hesap-ekstresi-detayli.pdf");
      if (!numaralar.length) return gonder(res, 400, { error: "Cari kartında Telefon 1, 2 veya 3 yok." });
      if (html.length < 40 || html.length > 2000000) return gonder(res, 400, { error: "Gönderilecek rapor yok." });
      const pdf = await htmlPdf(html);
      let adet = 0;
      let sonId = "";
      const hatalar = [];
      for (const no of numaralar) {
        try {
          const sonuc = await whatsappPdf(no, pdf, dosyaAdi, ozet);
          sonId = sonuc.id;
          adet += 1;
        } catch (error) {
          hatalar.push(error.message || "Gönderilemedi");
        }
      }
      if (!adet) return gonder(res, 400, { error: hatalar[0] || "WhatsApp gönderilemedi." });
      gonder(res, 200, { ok: true, id: sonId, adet, eksik: hatalar.length, dosya: true });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/satis-hizi") {
      if (!oturum(req)) return gonder(res, 401, { error: "Giriş gerekli." });
      const firma = tamSayi(url.searchParams.get("firma"));
      const donem = tamSayi(url.searchParams.get("donem"));
      const kod = metin(url.searchParams.get("kod"), 200).trim();
      if (!firma || !donem || !kod) return gonder(res, 400, { error: "Ürün seçin." });
      const hareket = donemTablo(firma, donem, "TBLSTOKHAREKETLERI");
      const stok = firmaTablo(firma, "TBLSTOKLAR");
      const lines = await queryLines(`
SET NOCOUNT ON;
SELECT
  MONTH(h.TARIH),
  CAST(SUM(ISNULL(h.CIKAN, 0)) AS decimal(18, 2)),
  CAST(SUM(ISNULL(h.TUTAR, 0)) AS decimal(18, 2))
FROM ${hareket} h
JOIN ${stok} s ON s.IND = h.STOKNO
WHERE s.STOKKODU COLLATE Latin1_General_CI_AI = N'${kod}'
  AND h.IZAHAT IN (21, 23, 33)
GROUP BY MONTH(h.TARIH)
ORDER BY MONTH(h.TARIH);
`);
      const bulunan = new Map(lines.map((line) => {
        const [ay, miktar, tutar] = line.split("|").map((part) => part.trim());
        return [Number(ay), { miktar: Number(miktar), tutar: Number(tutar) }];
      }));
      const adlar = ["Ocak", "Şubat", "Mart", "Nisan", "Mayıs", "Haziran", "Temmuz", "Ağustos", "Eylül", "Ekim", "Kasım", "Aralık"];
      const aylar = adlar.map((ad, index) => ({
        ay: index + 1,
        ad,
        miktar: bulunan.get(index + 1)?.miktar || 0,
        tutar: bulunan.get(index + 1)?.tutar || 0,
      }));
      const toplam = aylar.reduce((sum, ay) => sum + ay.miktar, 0);
      gonder(res, 200, { kod, aylar, toplam, ortalama: toplam / 12 });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/stok-fiyat") {
      const kim = oturum(req);
      if (!kim) return gonder(res, 401, { error: "Giriş gerekli." });
      const firma = tamSayi(kim.firma);
      const donem = tamSayi(kim.donem);
      const kod = metin(url.searchParams.get("kod"), 200).trim();
      if (!firma || !donem || !kod) return gonder(res, 400, { error: "Stok seçin." });
      const stok = firmaTablo(firma, "TBLSTOKLAR");
      const hareket = donemTablo(firma, donem, "TBLSTOKHAREKETLERI");
      const cari = firmaTablo(firma, "TBLCARI");
      if (!await nesneVar(stok)) return gonder(res, 400, { error: "Stok kartı bulunamadı." });
      const kolon = await kolonKumesi(stok);
      const fiyatAlan = ["ALISFIYATI", "SATISFIYATI", "SATISFIYATI1", "SATISFIYATI2", "SATISFIYATI3", "MALIYET"]
        .filter((ad) => kolon.has(ad));
      const yazi = (ifade, n = 200) => `REPLACE(REPLACE(REPLACE(RTRIM(ISNULL(CAST(${ifade} AS nvarchar(${n})), N'')), N'|', N'/'), CHAR(13), N' '), CHAR(10), N' ')`;
      const kartSatir = await queryLines(`
SET NOCOUNT ON;
SELECT
  ${yazi("s.STOKKODU", 80)},
  ${yazi("s.MALINCINSI", 200)}
  ${fiyatAlan.length ? ", " + fiyatAlan.map((ad) => `CAST(ISNULL(s.${ad}, 0) AS decimal(18, 4))`).join(", ") : ""}
FROM ${stok} s
WHERE s.STOKKODU COLLATE Latin1_General_CI_AI = N'${kod}'
  ${kolon.has("DELETED") ? "AND ISNULL(s.DELETED, 0) = 0" : ""};
`);
      if (!kartSatir.length) return gonder(res, 404, { error: "Stok bulunamadı." });
      const kartParca = kartSatir[0].split("|").map((part) => part.trim());
      const kart = { kod: kartParca[0] || kod, ad: kartParca[1] || "" };
      fiyatAlan.forEach((ad, index) => { kart[ad] = Number(kartParca[index + 2]) || 0; });
      const hareketVar = await nesneVar(hareket);
      const cariVar = await nesneVar(cari);
      const gecmis = async (tur) => {
        if (!hareketVar) return [];
        const hareketKolon = await kolonKumesi(hareket);
        if (!hareketKolon.has("BIRIMFIYAT")) return [];
        const yon = tur === "alis" ? "ISNULL(h.GIREN, 0) <> 0" : "ISNULL(h.CIKAN, 0) <> 0";
        const miktar = tur === "alis" ? "h.GIREN" : "h.CIKAN";
        const lines = await queryLines(`
SET NOCOUNT ON;
SELECT TOP 12
  CONVERT(varchar(10), h.TARIH, 104),
  CAST(ISNULL(h.BIRIMFIYAT, 0) AS decimal(18, 4)),
  CAST(ISNULL(${miktar}, 0) AS decimal(18, 2)),
  ${cariVar ? yazi("ISNULL(c.FIRMAADI, N'')", 120) : "N''"},
  CAST(ISNULL(h.IZAHAT, 0) AS varchar(6)),
  ${hareketKolon.has("PARABIRIMI") ? yazi("ISNULL(h.PARABIRIMI, N'TL')", 8) : "N'TL'"},
  ${yazi("RTRIM(ISNULL(h.EVRAKNO, N''))", 40)}
FROM ${hareket} h
JOIN ${stok} s ON s.IND = h.STOKNO
${cariVar ? `LEFT JOIN ${cari} c ON c.IND = h.FIRMANO` : ""}
WHERE s.STOKKODU COLLATE Latin1_General_CI_AI = N'${kod}'
  AND ${yon}
  AND ISNULL(h.IZAHAT, 0) NOT IN (94, 120)
ORDER BY h.TARIH DESC, h.IND DESC;
`);
        return lines.map((line) => {
          const [tarih, fiyat, miktarSayi, firmaAd, izahat, pb, evrak] = line.split("|").map((part) => part.trim());
          return {
            tarih,
            fiyat: Number(fiyat) || 0,
            miktar: Number(miktarSayi) || 0,
            firmaAd,
            izahat: Number(izahat) || 0,
            pb: pb || "TL",
            evrak,
          };
        });
      };
      gonder(res, 200, {
        kart,
        alislar: await gecmis("alis"),
        satislar: await gecmis("satis"),
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/fiyat-analizi") {
      if (!oturum(req)) return gonder(res, 401, { error: "Giriş gerekli." });
      const firma = tamSayi(url.searchParams.get("firma"));
      const donem = tamSayi(url.searchParams.get("donem"));
      const kod = metin(url.searchParams.get("kod"), 200).trim();
      const islem = String(url.searchParams.get("islem") || "giris");
      if (!firma || !donem || !kod) return gonder(res, 400, { error: "Ürün seçin." });
      const yon = islem === "cikis"
        ? "ISNULL(h.CIKAN, 0) <> 0"
        : islem === "tumu"
          ? "(ISNULL(h.GIREN, 0) <> 0 OR ISNULL(h.CIKAN, 0) <> 0)"
          : "ISNULL(h.GIREN, 0) <> 0";
      const hareket = donemTablo(firma, donem, "TBLSTOKHAREKETLERI");
      const stok = firmaTablo(firma, "TBLSTOKLAR");
      const cari = firmaTablo(firma, "TBLCARI");
      const lines = await queryLines(`
SET NOCOUNT ON;
SELECT
  h.IZAHAT,
  REPLACE(REPLACE(REPLACE(ISNULL(c.FIRMAKODU, N''), N'|', N'/'), CHAR(13), N' '), CHAR(10), N' '),
  REPLACE(REPLACE(REPLACE(ISNULL(c.FIRMAADI, N''), N'|', N'/'), CHAR(13), N' '), CHAR(10), N' '),
  CONVERT(varchar(10), h.TARIH, 104),
  CAST(ISNULL(h.BIRIMFIYAT, 0) AS decimal(18, 4)),
  CAST(CASE WHEN ISNULL(h.GIREN, 0) <> 0 THEN h.GIREN ELSE h.CIKAN END AS decimal(18, 4)),
  CAST(ISNULL(h.BIRIMMALIYET, 0) AS decimal(18, 4)),
  CAST(ISNULL(s.MALIYET, 0) AS decimal(18, 4)),
  CAST(ISNULL(h.KDV, 0) AS decimal(18, 2)),
  ISNULL(h.PARABIRIMI, N''),
  CAST(ISNULL(h.KUR, 0) AS decimal(18, 4)),
  CAST(ISNULL(h.BELGENO, 0) AS int),
  REPLACE(REPLACE(REPLACE(RTRIM(ISNULL(h.EVRAKNO, N'')), N'|', N'/'), CHAR(13), N' '), CHAR(10), N' ')
FROM ${hareket} h
JOIN ${stok} s ON s.IND = h.STOKNO
LEFT JOIN ${cari} c ON c.IND = h.FIRMANO
WHERE s.STOKKODU COLLATE Latin1_General_CI_AI = N'${kod}'
  AND h.IZAHAT NOT IN (94, 120)
  AND ${yon}
ORDER BY h.TARIH DESC, h.IND DESC;
`);
      const items = lines.map((line) => {
        const [izahat, firmaKod, firmaAd, tarih, fiyat, miktar, maliyet, kartMaliyet, kdv, pb, kur, belgeNo, evrakNo] = line.split("|").map((part) => part.trim());
        return {
          izahat: Number(izahat),
          firmaKod,
          firmaAd,
          tarih,
          fiyat: Number(fiyat),
          miktar: Number(miktar),
          maliyet: Number(maliyet),
          kartMaliyet: Number(kartMaliyet),
          kdv: Number(kdv),
          pb,
          kur: Number(kur),
          belgeNo: Number(belgeNo),
          evrakNo,
        };
      });
      const kalanSatir = await queryLines(`
SET NOCOUNT ON;
SELECT N'stok', CAST(ISNULL(MAX(s.KALAN), 0) AS decimal(18, 2))
FROM ${stok} s
WHERE s.STOKKODU COLLATE Latin1_General_CI_AI = N'${kod}'
  AND ISNULL(s.DELETED, 0) = 0;
`);
      const kalan = kalanSatir.length ? Number(kalanSatir[0].split("|")[1]) : 0;
      const ortalamaFiyat = items.length ? items.reduce((sum, row) => sum + row.fiyat, 0) / items.length : 0;
      const toplamMiktar = items.reduce((sum, row) => sum + row.miktar, 0);
      gonder(res, 200, { kod, items, ortalamaFiyat, toplamMiktar, kalan });
      return;
    }

    async function bordroGorselleri(baslikTablo, belgeNo) {
      try {
        const dokuman = await queryLines(`
SET NOCOUNT ON;
SELECT CAST(d.Id AS varchar(12)), RTRIM(REPLACE(ISNULL(d.Name, N''), N'|', N'/'))
FROM ${baslikTablo} b
JOIN VegaDocuments.dbo.Documents d
  ON UPPER(REPLACE(REPLACE(RTRIM(CAST(b.UID AS nvarchar(40))), N'{', N''), N'}', N''))
   = UPPER(REPLACE(REPLACE(RTRIM(d.OwnerGuid), N'{', N''), N'}', N''))
WHERE ISNULL(d.Deleted, 0) = 0 AND b.IND = ${belgeNo};
`);
        return dokuman.map((line) => {
          const [id, ad] = line.split("|").map((part) => part.trim());
          return { id: Number(id) || 0, ad };
        }).filter((gorsel) => gorsel.id);
      } catch {
        return [];
      }
    }

    if (req.method === "GET" && url.pathname === "/api/belge") {
      if (!oturum(req)) return gonder(res, 401, { error: "Giriş gerekli." });
      const firma = tamSayi(url.searchParams.get("firma"));
      const donem = tamSayi(url.searchParams.get("donem"));
      const izahat = tamSayi(url.searchParams.get("izahat"), 999);
      const belgeNo = tamSayi(url.searchParams.get("belge"), 999999999);
      const evrak = metin(url.searchParams.get("evrak"), 40).trim();
      if (!firma || !donem || izahat == null || (!belgeNo && !evrak)) return gonder(res, 400, { error: "Belge seçin." });
      const hareket = donemTablo(firma, donem, "TBLSTOKHAREKETLERI");
      const stok = firmaTablo(firma, "TBLSTOKLAR");
      const cari = firmaTablo(firma, "TBLCARI");
      const birim = firmaTablo(firma, "TBLBIRIMLEREX");
      const depo = firmaTablo(firma, "TBLDEPOLAR");
      const sube = firmaTablo(firma, "TBLSUBELER");
      const kasa = firmaTablo(firma, "TBLKASA");
      const temiz = (ifade) => `REPLACE(REPLACE(REPLACE(RTRIM(ISNULL(${ifade}, N'')), N'|', N'/'), CHAR(13), N' '), CHAR(10), N' ')`;
      const cikisBelge = izahat === 11 || izahat === 12 || izahat === 19;
      const girisBelge = izahat === 13 || izahat === 14 || izahat === 18;
      if ((cikisBelge || girisBelge) && belgeNo) {
        const baslikTablo = donemTablo(firma, donem, cikisBelge ? "TBLCARCIKBASLIK" : "TBLCARGIRBASLIK");
        const detayTablo = donemTablo(firma, donem, cikisBelge ? "TBLCARCIKHAREKET" : "TBLCARGIRHAREKET");
        const baslikSatir = await queryLines(`
SET NOCOUNT ON;
SELECT
  ${temiz("b.BELGENO")},
  CONVERT(varchar(10), b.TARIH, 104),
  CAST(ISNULL(b.TUTAR, 0) AS decimal(18, 2)),
  ${temiz("b.PARABIRIMI")},
  CAST(ISNULL(b.KUR, 0) AS decimal(18, 4)),
  CAST(ISNULL(b.AYLIKVADE, 0) AS decimal(18, 2)),
  ${temiz("b.OZELKOD1")},
  ${temiz("b.OZELKOD2")},
  ${temiz("b.OZELKOD3")},
  ${temiz("b.OZELKOD4")},
  ${temiz("b.OZELKOD5")},
  ${temiz("b.OZELKOD6")},
  ${temiz("CAST(b.ACIKLAMA AS nvarchar(400))")},
  ${temiz("c.FIRMAKODU")},
  ${temiz("c.FIRMAADI")}
FROM ${baslikTablo} b
LEFT JOIN ${cari} c ON c.IND = b.FIRMANO
WHERE b.IND = ${belgeNo};
`);
        if (baslikSatir.length) {
          const [evrakNo, tarih, tutar, pb, kur, vadeYuzde, subeAd, kasaAd, ok1, ok2, ok3, ok4, aciklama, firmaKod, firmaAd] = baslikSatir[0].split("|").map((part) => part.trim());
          const detaySatir = await queryLines(`
SET NOCOUNT ON;
SELECT
  h.IZAHAT,
  CASE WHEN ISNULL(h.PORTNO, 0) > 0 THEN 100000000 + h.PORTNO ELSE 0 END,
  ${temiz("CAST(h.ACIKLAMA AS nvarchar(200))")},
  CASE WHEN h.VADE IS NULL THEN 0 ELSE DATEDIFF(day, b.TARIH, h.VADE) END,
  CONVERT(varchar(10), h.VADE, 104),
  CAST(ISNULL(h.TUTAR, 0) AS decimal(18, 2)),
  ${temiz("h.PARABIRIMI")},
  CAST(ISNULL(h.KUR, 0) AS decimal(18, 4))
FROM ${detayTablo} h
JOIN ${baslikTablo} b ON b.IND = ${belgeNo}
WHERE RTRIM(ISNULL(h.EVRAKNO, N'')) = N'${belgeNo}'
ORDER BY h.IND;
`);
          const items = detaySatir.map((line) => {
            const [satirIzahat, portfoyNo, satirAciklama, gun, vade, satirTutar, satirPb, satirKur] = line.split("|").map((part) => part.trim());
            return {
              izahat: Number(satirIzahat),
              portfoyNo: Number(portfoyNo) || 0,
              aciklama: satirAciklama,
              gun: Number(gun) || 0,
              vade,
              tutar: Number(satirTutar),
              pb: satirPb,
              kur: Number(satirKur),
            };
          });
          gonder(res, 200, {
            tur: cikisBelge ? "carcik" : "cargir",
            izahat,
            belgeNo,
            evrakNo,
            tarih,
            tutar: Number(tutar),
            pb,
            kur: Number(kur),
            vadeYuzde: Number(vadeYuzde),
            sube: subeAd,
            kasa: kasaAd,
            ok1, ok2, ok3, ok4,
            aciklama,
            firmaKod,
            firmaAd,
            items,
            gorseller: await bordroGorselleri(baslikTablo, belgeNo),
          });
          return;
        }
      }
      const lines = await queryLines(`
SET NOCOUNT ON;
SELECT
  ${temiz("s.STOKKODU")},
  ${temiz("s.MALINCINSI")},
  ${temiz("h.ACIKLAMA")},
  CAST(CASE WHEN ISNULL(h.GIREN, 0) <> 0 THEN h.GIREN ELSE h.CIKAN END AS decimal(18, 4)),
  ${temiz("b.BIRIMADI")},
  CAST(ISNULL(h.KDV, 0) AS decimal(18, 2)),
  CAST(ISNULL(h.KUR, 0) AS decimal(18, 4)),
  ${temiz("h.PARABIRIMI")},
  CAST(ISNULL(h.BIRIMFIYAT, 0) AS decimal(18, 4)),
  CAST(ISNULL(h.TUTAR, 0) AS decimal(18, 4)),
  ${temiz("h.EVRAKNO")},
  CONVERT(varchar(10), h.TARIH, 104),
  ${temiz("c.FIRMAKODU")},
  ${temiz("c.FIRMAADI")},
  ${temiz("d.DEPOADI")},
  ${temiz("ISNULL(sb.SUBEAD, (SELECT TOP 1 sb2.SUBEAD FROM " + sube + " sb2 ORDER BY sb2.IND))")},
  ${temiz("(SELECT TOP 1 ks.KASAADI FROM " + kasa + " ks ORDER BY ks.IND)")}
FROM ${hareket} h
JOIN ${stok} s ON s.IND = h.STOKNO
LEFT JOIN ${cari} c ON c.IND = h.FIRMANO
LEFT JOIN ${birim} b ON b.IND = h.BIRIMEX
LEFT JOIN ${depo} d ON d.IND = h.DEPO
LEFT JOIN ${sube} sb ON sb.IND = d.SUBE
WHERE h.IZAHAT = ${izahat} AND h.BELGENO = ${belgeNo || 0} AND ${belgeNo ? 1 : 0} = 1
ORDER BY h.IND;
`);
      let items = lines.map((line) => {
        const [kod, ad, aciklama, miktar, birimAd, kdv, kur, pb, fiyat, tutar, evrakNo, tarih, firmaKod, firmaAd, depoAd, subeAd, kasaAd] = line.split("|").map((part) => part.trim());
        return {
          kod, ad, aciklama, birimAd, pb, evrakNo, tarih, firmaKod, firmaAd, depoAd, subeAd, kasaAd,
          miktar: Number(miktar),
          kdv: Number(kdv),
          kur: Number(kur),
          fiyat: Number(fiyat),
          tutar: Number(tutar),
        };
      });
      const faturaKok = ({ 20: "TBLALFAT", 21: "TBLSATFAT", 22: "TBLALFAT", 23: "TBLSATFAT", 26: "TBLALIRS", 27: "TBLSATIRS", 28: "TBLALIRS", 29: "TBLSATIRS" })[izahat];
      if (!items.length && faturaKok && belgeNo) {
        const fatBaslik = donemTablo(firma, donem, faturaKok + "BASLIK");
        const fatHareket = donemTablo(firma, donem, faturaKok + "HAREKET");
        const fatSatir = await queryLines(`
SET NOCOUNT ON;
SELECT
  ${temiz("h.STOKKODU")},
  ${temiz("CASE WHEN RTRIM(ISNULL(h.MALINCINSI, N'')) <> N'' THEN h.MALINCINSI ELSE s.MALINCINSI END")},
  ${temiz("h.ACIKLAMA")},
  CAST(ISNULL(h.MIKTAR, 0) AS decimal(18, 4)),
  ${temiz("b.BIRIMADI")},
  CAST(ISNULL(h.KDV, 0) AS decimal(18, 2)),
  CAST(ISNULL(h.KUR, 0) AS decimal(18, 4)),
  ${temiz("h.PARABIRIMI")},
  CAST(ISNULL(h.FIYATI, 0) AS decimal(18, 4)),
  CAST(ISNULL(h.GERCEKTOPLAM, 0) AS decimal(18, 4)),
  ${temiz("bas.BELGENO")},
  CONVERT(varchar(10), ISNULL(h.TARIH, bas.TARIH), 104),
  ${temiz("c.FIRMAKODU")},
  ${temiz("c.FIRMAADI")},
  ${temiz("d.DEPOADI")},
  ${temiz("ISNULL(sb.SUBEAD, (SELECT TOP 1 sb2.SUBEAD FROM " + sube + " sb2 ORDER BY sb2.IND))")},
  ${temiz("(SELECT TOP 1 ks.KASAADI FROM " + kasa + " ks ORDER BY ks.IND)")}
FROM ${fatHareket} h
JOIN ${fatBaslik} bas ON bas.IND = ${belgeNo}
LEFT JOIN ${stok} s ON s.IND = h.STOKNO
LEFT JOIN ${cari} c ON c.IND = ISNULL(NULLIF(h.FIRMANO, 0), bas.FIRMANO)
LEFT JOIN ${birim} b ON b.IND = h.BIRIMEX
LEFT JOIN ${depo} d ON d.IND = ISNULL(NULLIF(h.DEPO, 0), bas.HAREKETDEPOSU)
LEFT JOIN ${sube} sb ON sb.IND = d.SUBE
WHERE RTRIM(ISNULL(h.EVRAKNO, N'')) = N'${belgeNo}'
ORDER BY h.IND;
`);
        items = fatSatir.map((line) => {
          const [kod, ad, aciklama, miktar, birimAd, kdv, kur, pb, fiyat, tutar, evrakNo, tarih, firmaKod, firmaAd, depoAd, subeAd, kasaAd] = line.split("|").map((part) => part.trim());
          return {
            kod, ad, aciklama, birimAd, pb, evrakNo, tarih, firmaKod, firmaAd, depoAd, subeAd, kasaAd,
            miktar: Number(miktar),
            kdv: Number(kdv),
            kur: Number(kur),
            fiyat: Number(fiyat),
            tutar: Number(tutar),
          };
        });
      }
      if (!items.length) {
        const cariHareket = donemTablo(firma, donem, "TBLCARIHAREKETLERI");
        const bag = belgeNo
          ? `h.LN = ${belgeNo}`
          : `RTRIM(ISNULL(h.EVRAKNO, N'')) = N'${evrak}'`;
        const cariSatir = await queryLines(`
SET NOCOUNT ON;
SELECT
  ${temiz("c.FIRMAKODU")},
  ${temiz("c.FIRMAADI")},
  CAST(CASE WHEN ISNULL(h.BORC, 0) <> 0 THEN h.BORC ELSE h.ALACAK END AS decimal(18, 2)),
  ${temiz("h.PARABIRIMI")},
  CAST(ISNULL(h.KUR, 0) AS decimal(18, 4)),
  ${temiz("h.EVRAKNO")},
  CONVERT(varchar(10), h.TARIH, 104)
FROM ${cariHareket} h
LEFT JOIN ${cari} c ON c.IND = h.FIRMANO
WHERE h.IZAHAT = ${izahat} AND ${bag}
ORDER BY h.IND;
`);
        items = cariSatir.map((line) => {
          const [firmaKod, firmaAd, tutar, pb, kur, evrakNo, tarih] = line.split("|").map((part) => part.trim());
          return {
            kod: "",
            ad: "",
            aciklama: firmaAd,
            birimAd: "",
            pb,
            evrakNo,
            tarih,
            firmaKod,
            firmaAd,
            depoAd: "",
            subeAd: "",
            kasaAd: "",
            miktar: 1,
            kdv: 0,
            kur: Number(kur),
            fiyat: Number(tutar),
            tutar: Number(tutar),
          };
        });
      }
      const ilk = items[0] || {};
      let bankaKod = "";
      let bankaAd = "";
      let hesapNo = "";
      if (izahat === 83 && belgeNo) {
        const giris = donemTablo(firma, donem, "TBLBANKGIRBASLIK");
        const cikis = donemTablo(firma, donem, "TBLBANKCIKBASLIK");
        const kart = firmaTablo(firma, "TBLBANKALAR");
        const bankaSatir = await queryLines(`
SET NOCOUNT ON;
SELECT TOP 1
  ${temiz("k.KOD")},
  ${temiz("k.ADI")},
  ${temiz("k.HESAPNO")}
FROM (
  SELECT 1 AS sira, BANKANO FROM ${giris} WHERE IND = ${belgeNo}
  UNION ALL
  SELECT 2, BANKANO FROM ${cikis} WHERE IND = ${belgeNo}
) b
JOIN ${kart} k ON k.IND = b.BANKANO
ORDER BY b.sira;
`);
        if (bankaSatir.length) {
          [bankaKod, bankaAd, hesapNo] = bankaSatir[0].split("|").map((part) => part.trim());
        }
      }
      gonder(res, 200, {
        izahat,
        belgeNo,
        banka: Boolean(bankaKod || bankaAd),
        evrakNo: ilk.evrakNo || "",
        tarih: ilk.tarih || "",
        firmaKod: bankaKod || ilk.firmaKod || "",
        firmaAd: bankaAd || ilk.firmaAd || "",
        depo: hesapNo || ilk.depoAd || "",
        sube: ilk.subeAd || "",
        kasa: ilk.kasaAd || "",
        pb: ilk.pb || "",
        kur: ilk.kur || 0,
        items,
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/bordro") {
      const kim = oturum(req);
      if (!kim) return gonder(res, 401, { error: "Giriş gerekli." });
      const body = await okuGovde(req);
      const cikis = body.tur === "cikis";
      const kod = metin(body.kod, 40).trim();
      const tarih = sqlTarihIfade(body.tarih);
      const izinli = new Set([1, 2, 4, 6, 11]);
      const temizSatir = [];
      for (const satir of Array.isArray(body.satirlar) ? body.satirlar : []) {
        const izahat = tamSayi(satir?.izahat, 11);
        const tutar = Number(satir?.tutar);
        if (!izinli.has(izahat) || !Number.isFinite(tutar) || tutar <= 0) continue;
        const vade = sqlTarihIfade(satir?.vade) || tarih;
        if (!vade) continue;
        const port = portNo(satir?.portfoy);
        temizSatir.push({
          izahat,
          portno: port > 0 ? port : -1,
          aciklama: metin(satir?.aciklama, 200),
          vade,
          tutar: sqlOndalik(tutar),
          pb: metin(satir?.pb || body.pb || "TL", 3).trim() || "TL",
          kur: sqlOndalik(satir?.kur || body.kur || 1),
        });
      }
      if (!kod || !tarih || !temizSatir.length) {
        return gonder(res, 400, { error: "Firma, tarih ve en az bir tutarlı satır gerekli." });
      }
      const toplam = sqlOndalik(temizSatir.reduce((sum, satir) => sum + Number(satir.tutar), 0));
      const pb = metin(body.pb || "TL", 3).trim() || "TL";
      const kur = sqlOndalik(body.kur || 1);
      const baslik = donemTablo(kim.firma, kim.donem, cikis ? "TBLCARCIKBASLIK" : "TBLCARGIRBASLIK");
      const detay = donemTablo(kim.firma, kim.donem, cikis ? "TBLCARCIKHAREKET" : "TBLCARGIRHAREKET");
      const hareket = donemTablo(kim.firma, kim.donem, "TBLCARIHAREKETLERI");
      const cari = firmaTablo(kim.firma, "TBLCARI");
      const onek = cikis ? "ARC" : "C";
      const hane = cikis ? 5 : 7;
      const basamak = cikis ? 4 : 2;
      const satirSql = temizSatir.map((satir) => `
INSERT INTO ${detay} (IZAHAT, PORTNO, EVRAKNO, ACIKLAMA, VADE, TUTAR, PARABIRIMI, KUR, FIRMANO, STATUS)
VALUES (${satir.izahat}, ${satir.portno}, @ind, ${satir.aciklama ? `N'${satir.aciklama}'` : "NULL"}, ${satir.vade}, ${satir.tutar}, N'${satir.pb}', ${satir.kur}, @firma, 0);`).join("");
      const sql = `
SET NOCOUNT ON;
SET XACT_ABORT ON;
BEGIN TRY
  BEGIN TRAN;
  DECLARE @firma int, @ind int, @sira int, @belge nvarchar(16), @simdi datetime, @siraTarih datetime;
  SELECT TOP 1 @firma = IND
  FROM ${cari}
  WHERE FIRMAKODU COLLATE Turkish_CI_AS = N'${kod}'
  ORDER BY CASE WHEN ISNULL(STATUS, 1) = 2 THEN 1 ELSE 0 END, IND;
  IF @firma IS NULL
  BEGIN
    ROLLBACK;
    SELECT N'hata|Cari bulunamadı';
    RETURN;
  END
  SELECT @sira = ISNULL(MAX(CONVERT(int, SUBSTRING(BELGENO, ${basamak}, 16))), 0) + 1
  FROM ${baslik} WITH (UPDLOCK, HOLDLOCK)
  WHERE BELGENO LIKE N'${onek}' + REPLICATE(N'[0-9]', ${hane});
  SET @belge = N'${onek}' + RIGHT(REPLICATE(N'0', ${hane}) + CAST(@sira AS nvarchar(10)), CASE WHEN LEN(CAST(@sira AS nvarchar(10))) > ${hane} THEN LEN(CAST(@sira AS nvarchar(10))) ELSE ${hane} END);
  INSERT INTO ${baslik} (
    FIRMANO, BELGENO, TARIH, IADE, AYLIKVADE, TUTAR, PARABIRIMI, KUR, BELGETIPI, IPTAL, GIRIS,
    USERNO, OZELKOD1, OZELKOD2, OZELKOD3, OZELKOD4, OZELKOD5, OZELKOD6, ACIKLAMA, MUHASEBELESMEYECEK, CREDATE
  ) VALUES (
    @firma, @belge, ${tarih}, NULL, ${sqlOndalik(body.vadeYuzde || 0)}, ${toplam}, N'${pb}', ${kur}, ${cikis ? 11 : 13}, 0, ${cikis ? 0 : 1},
    ${tamSayi(kim.no, 999999) || 0}, N'${metin(body.sube || "MERKEZ", 15)}', N'${metin(body.kasa || "MERKEZ", 15)}',
    NULLIF(N'${metin(body.ok1, 30)}', N''), NULLIF(N'${metin(body.ok2, 30)}', N''), NULLIF(N'${metin(body.ok3, 200)}', N''), NULLIF(N'${metin(body.ok4, 30)}', N''),
    NULLIF(N'${metin(body.aciklama, 400)}', N''), 0, GETDATE()
  );
  SET @ind = SCOPE_IDENTITY();
  ${satirSql}
  SET @simdi = GETDATE();
  SET @siraTarih = DATEADD(second, DATEDIFF(second, CONVERT(datetime, CONVERT(varchar(8), @simdi, 112)), @simdi), ${tarih});
  INSERT INTO ${hareket} (
    IZAHAT, LN, LN2, EVRAKNO, BORC, ALACAK, PARABIRIMI, KUR, TARIH, FIRMANO,
    ODEMETARIHI, ISLEMTARIHI, SIRALAMATARIHI, SIRALAMATARIHIEX, OZELKOD1
  ) VALUES (
    ${cikis ? 11 : 13}, @ind, 0, @belge, ${cikis ? toplam : "0"}, ${cikis ? "0" : toplam}, N'${pb}', ${kur}, ${tarih}, @firma,
    ${tarih}, @simdi, @siraTarih, CAST(@siraTarih AS float) + 2, N'${metin(body.sube || "MERKEZ", 15)}'
  );
  COMMIT;
  SELECT N'ok|' + @belge + N'|' + CAST(@ind AS nvarchar(20));
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK;
  SELECT N'hata|' + REPLACE(REPLACE(ERROR_MESSAGE(), N'|', N'/'), NCHAR(13), N' ');
END CATCH;
`;
      const sonuc = await queryLines(sql);
      const parca = (sonuc[0] || "").split("|");
      if (parca[0] !== "ok") return gonder(res, 400, { error: parca.slice(1).join("|") || "Belge yazılamadı." });
      gonder(res, 200, { belgeNo: parca[1], belgeInd: Number(parca[2]) || 0 });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/urun-internet") {
      if (!oturum(req)) return gonder(res, 401, { error: "Giriş gerekli." });
      const q = metin(url.searchParams.get("q"), 120).trim();
      gonder(res, 200, await urunInternetBul(q));
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/teklif-gorsel") {
      if (!oturum(req)) return gonder(res, 401, { error: "Giriş gerekli." });
      const firma = tamSayi(url.searchParams.get("firma"));
      const stok = tamSayi(url.searchParams.get("stok"), 999999999);
      const belge = tamSayi(url.searchParams.get("belge"), 999999999);
      const satir = tamSayi(url.searchParams.get("satir"), 99);
      const kod = String(url.searchParams.get("kod") || "").trim().slice(0, 80);
      if (!firma) { res.writeHead(404); res.end(); return; }
      const stokDosya = stok ? teklifResimBul(firma, `S${stok}`) : "";
      if (stokDosya) return teklifResimGonder(res, stokDosya);
      const kodAnahtar = teklifStokKodAnahtar(kod);
      const kodDosya = kodAnahtar ? teklifResimBul(firma, kodAnahtar) : "";
      if (kodDosya) return teklifResimGonder(res, kodDosya);
      const satirDosya = belge && satir ? teklifResimBul(firma, `B${belge}-${satir}`) : "";
      if (satirDosya) return teklifResimGonder(res, satirDosya);
      if (!stok) { res.writeHead(404); res.end(); return; }
      const buf = await vegaStokResmi(firma, stok);
      return teklifResimGonder(res, "", buf);
    }

    if (req.method === "POST" && url.pathname === "/api/teklif-gorsel") {
      const kim = oturum(req);
      if (!kim) return gonder(res, 401, { error: "Giriş gerekli." });
      const body = await okuGovde(req);
      const firma = tamSayi(body.firma) || tamSayi(kim.firma);
      const stok = tamSayi(body.stok, 999999999);
      const belge = tamSayi(body.belge, 999999999);
      const satir = tamSayi(body.satir, 99);
      const kod = String(body.kod || "").trim().slice(0, 80);
      const kodAnahtar = teklifStokKodAnahtar(kod);
      const buf = teklifResimCoz(body.resim);
      if (!firma || !buf || (!stok && !kodAnahtar && !(belge && satir))) return gonder(res, 400, { error: "Stok seçip resim ekleyin." });
      if (stok) teklifResimKaydet(firma, `S${stok}`, buf);
      if (kodAnahtar) teklifResimKaydet(firma, kodAnahtar, buf);
      if (belge && satir) teklifResimKaydet(firma, `B${belge}-${satir}`, buf);
      gonder(res, 200, { ok: true, stok: stok || 0, kod });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/doviz-kur") {
      if (!oturum(req)) return gonder(res, 401, { error: "Giriş gerekli." });
      const pb = teklifPbKod(url.searchParams.get("pb"));
      if (pb === "TL") return gonder(res, 200, { bulundu: true, kur: 1 });
      const gun = dovizGunIfade(url.searchParams.get("tarih"));
      const eslesme = dovizEslesme(pb);
      if (!gun || !eslesme) return gonder(res, 400, { error: "Tarih ve para birimi seçin." });
      const kurTablo = await nesneVar(["TBLDOVIZKURU", "TBLDOVKURU"]);
      const dovizTablo = await nesneVar("TBLDOVIZLER");
      if (!kurTablo || !dovizTablo) return gonder(res, 200, { bulundu: false });
      const kolon = await kolonKumesi(kurTablo);
      const fiyat = ["SATISFIYATI", "SATIS", "EFEKTIFSATIS", "KUR"].find((ad) => kolon.has(ad));
      if (!fiyat || !kolon.has("TARIH") || !kolon.has("DOVIZ")) return gonder(res, 200, { bulundu: false });
      const lines = await queryLines(`
SET NOCOUNT ON;
SELECT TOP 1 N'k', REPLACE(CONVERT(varchar(40), CAST(k.${fiyat} AS decimal(18, 6))), ',', '.')
FROM ${kurTablo} k
INNER JOIN ${dovizTablo} d ON d.IND = k.DOVIZ
WHERE k.TARIH >= ${gun} AND k.TARIH < DATEADD(day, 1, ${gun})
  AND ${eslesme}
ORDER BY k.TARIH DESC;
`);
      const kur = Number(String((lines[0] || "").split("|")[1] || "").replace(",", "."));
      if (!Number.isFinite(kur) || kur <= 0) return gonder(res, 200, { bulundu: false });
      return gonder(res, 200, { bulundu: true, kur });
    }

    if (req.method === "GET" && url.pathname === "/api/piyasa") {
      if (!oturum(req)) return gonder(res, 401, { error: "Giriş gerekli." });
      gonder(res, 200, await piyasaGetir());
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/tcmb-kur") {
      if (!oturum(req)) return gonder(res, 401, { error: "Giriş gerekli." });
      const sonuc = await tcmbKurOku(url.searchParams.get("pb"), url.searchParams.get("tarih"));
      return gonder(res, 200, sonuc);
    }

    if (req.method === "GET" && url.pathname === "/api/cari-numaralar") {
      if (!oturum(req)) return gonder(res, 401, { error: "Giriş gerekli." });
      const firma = tamSayi(url.searchParams.get("firma"));
      const kod = metin(url.searchParams.get("kod"), 40).trim();
      if (!firma || !kod) return gonder(res, 400, { error: "Cari seçin." });
      const tablo = firmaTablo(firma, "TBLCARI");
      if (!await nesneVar(tablo)) return gonder(res, 200, { smsGonder: false, dolu: 0, kisiler: [] });
      const kolon = await kolonKumesi(tablo);
      if (!kolon.has("FIRMAKODU")) return gonder(res, 200, { smsGonder: false, dolu: 0, kisiler: [] });
      const yazi = (ad, n) => kolon.has(ad)
        ? `REPLACE(REPLACE(REPLACE(RTRIM(ISNULL(CAST(${ad} AS nvarchar(${n})), N'')), N'|', N'/'), CHAR(13), N' '), CHAR(10), N' ')`
        : "N''";
      const smsAlan = kolon.has("SMSGONDERILSIN") ? "SMSGONDERILSIN" : kolon.has("SMSGONDER") ? "SMSGONDER" : "";
      const smsIfade = smsAlan
        ? `CASE WHEN ISNULL(CAST(${smsAlan} AS int), 0) = 1 OR UPPER(LTRIM(RTRIM(CAST(${smsAlan} AS nvarchar(10))))) IN (N'1', N'TRUE', N'EVET', N'E') THEN 1 ELSE 0 END`
        : "0";
      const alanlar = ["FIRMAADI", "YETKILI", "ADI", "SOYADI", "KEFIL1", "KEFIL2", "TELEFON1", "TELEFON2", "TELEFON3", "YGSM", "YTELEFON1", "YTELEFON2", "KEFIL1TELEFON", "KEFIL1CEPTELEFON", "KEFIL2TELEFON", "KEFIL2CEPTELEFON"];
      const lines = await queryLines(`
SET NOCOUNT ON;
SELECT
  ${alanlar.map((ad) => yazi(ad, /TEL|GSM|CEP/.test(ad) ? 40 : 200)).join(",\n  ")},
  ${smsIfade}
FROM ${tablo}
WHERE FIRMAKODU COLLATE Turkish_CI_AS = N'${kod}';
`);
      if (!lines.length) return gonder(res, 200, { smsGonder: false, dolu: 0, kisiler: [] });
      const parca = lines[0].split("|").map((part) => part.trim());
      const deger = {};
      alanlar.forEach((ad, index) => { deger[ad] = parca[index] || ""; });
      const liste = cariTelefonKisileri(deger);
      await whatsappRehberHazir(liste.kisiler.map((kisi) => kisi.telefon));
      for (const kisi of liste.kisiler) {
        const gorunen = whatsappGorunenAd(kisi.telefon);
        kisi.ad = gorunen.ad;
        kisi.adKaynak = gorunen.kaynak;
      }
      gonder(res, 200, { smsGonder: parca[alanlar.length] === "1", dolu: liste.dolu, kisiler: liste.kisiler });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/fiyat-teklif") {
      if (!oturum(req)) return gonder(res, 401, { error: "Giriş gerekli." });
      const firma = tamSayi(url.searchParams.get("firma"));
      const donem = tamSayi(url.searchParams.get("donem"));
      const bas = sqlTarihIfade(url.searchParams.get("bas"));
      const bit = sqlTarihIfade(url.searchParams.get("bit"));
      if (!firma || !donem) return gonder(res, 400, { error: "Firma ve dönem seçin." });
      const baslik = donemTablo(firma, donem, "TBLPROFATBASLIK");
      if (!await nesneVar(baslik)) return gonder(res, 200, { items: [] });
      const cari = firmaTablo(firma, "TBLCARI");
      const depo = firmaTablo(firma, "TBLDEPOLAR");
      const cariVar = await nesneVar(cari);
      const depoVar = await nesneVar(depo);
      const yazi = (ifade, n = 200) => `REPLACE(REPLACE(REPLACE(RTRIM(ISNULL(CAST(${ifade} AS nvarchar(${n})), N'')), N'|', N'/'), CHAR(13), N' '), CHAR(10), N' ')`;
      const tarihKosul = bas && bit ? `b.TARIH >= ${bas} AND b.TARIH < DATEADD(day, 1, ${bit})` : "1 = 1";
      const lines = await queryLines(`
SET NOCOUNT ON;
SELECT
  CAST(b.IND AS varchar(12)),
  CONVERT(varchar(10), b.TARIH, 104),
  ${yazi("b.BELGENO", 30)},
  ${cariVar ? yazi("c.FIRMAKODU", 40) : "N''"},
  CASE WHEN ${cariVar ? yazi("c.FIRMAADI", 200) : "N''"} <> N'' THEN ${cariVar ? yazi("c.FIRMAADI", 200) : "N''"} ELSE ${yazi("b.FIRMAADI", 40)} END,
  CAST(ISNULL(b.ARATOPLAM, 0) AS decimal(18, 2)),
  CAST(ISNULL(b.TUTAR, 0) AS decimal(18, 2)),
  ${yazi("b.PARABIRIMI", 5)},
  CAST(ISNULL(b.KUR, 0) AS decimal(18, 4)),
  CASE WHEN ISNULL(b.IPTAL, 0) = 1 THEN N'1' ELSE N'0' END,
  CASE WHEN ISNULL(b.CONVERTED, 0) = 1 THEN N'1' ELSE N'0' END,
  ISNULL(CONVERT(varchar(10), b.SONGECERLILIKTARIHI, 104), N''),
  ${yazi("b.OZELKOD1", 20)},
  ${depoVar ? yazi("d.DEPOADI", 40) : "N''"}
FROM ${baslik} b
${cariVar ? `LEFT JOIN ${cari} c ON c.IND = b.FIRMANO` : ""}
${depoVar ? `LEFT JOIN ${depo} d ON d.IND = b.HAREKETDEPOSU` : ""}
WHERE ISNULL(b.BELGETIPI, 0) = 120 AND ${tarihKosul}
ORDER BY b.TARIH DESC, b.IND DESC;
`);
      const items = lines.map((line) => {
        const [ind, tarih, belge, firmaKod, firmaAd, ara, tutar, pb, kur, iptal, converted, gecerlilik, ozelkod, depoAd] = line.split("|").map((part) => part.trim());
        const araSayi = Number(ara) || 0;
        const tutarSayi = Number(tutar) || 0;
        return {
          ind: Number(ind) || 0,
          tarih, belge, firmaKod, firmaAd, pb, gecerlilik, ozelkod, depo: depoAd,
          ara: araSayi,
          tutar: tutarSayi,
          kdv: Math.max(0, Math.round((tutarSayi - araSayi) * 100) / 100),
          kur: Number(kur) || 0,
          iptal: iptal === "1",
          converted: converted === "1",
        };
      }).filter((item) => item.ind);
      gonder(res, 200, { items });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/fiyat-teklif-detay") {
      if (!oturum(req)) return gonder(res, 401, { error: "Giriş gerekli." });
      const firma = tamSayi(url.searchParams.get("firma"));
      const donem = tamSayi(url.searchParams.get("donem"));
      const ind = tamSayi(url.searchParams.get("ind"), 999999999);
      if (!firma || !donem || !ind) return gonder(res, 400, { error: "Teklif seçin." });
      const baslik = donemTablo(firma, donem, "TBLPROFATBASLIK");
      const hareket = donemTablo(firma, donem, "TBLPROFATHAREKET");
      if (!await nesneVar(baslik)) return gonder(res, 404, { error: "Teklif bulunamadı." });
      const cari = firmaTablo(firma, "TBLCARI");
      const cariVar = await nesneVar(cari);
      const yazi = (ifade, n = 200) => `REPLACE(REPLACE(REPLACE(RTRIM(ISNULL(CAST(${ifade} AS nvarchar(${n})), N'')), N'|', N'/'), CHAR(13), N' '), CHAR(10), N' ')`;
      const basSatir = await queryLines(`
SET NOCOUNT ON;
SELECT
  CAST(b.IND AS varchar(12)),
  CONVERT(varchar(10), b.TARIH, 104),
  ISNULL(CONVERT(varchar(10), b.SONGECERLILIKTARIHI, 104), N''),
  ${yazi("b.BELGENO", 30)},
  ${cariVar ? yazi("c.FIRMAKODU", 40) : "N''"},
  CASE WHEN ${cariVar ? yazi("c.FIRMAADI", 200) : "N''"} <> N'' THEN ${cariVar ? yazi("c.FIRMAADI", 200) : "N''"} ELSE ${yazi("b.FIRMAADI", 40)} END,
  ${cariVar ? yazi("c.ADRESFATURA", 300) : "N''"},
  ${cariVar ? yazi("c.SEHIR", 40) : "N''"},
  ${cariVar ? yazi("c.TELEFON1", 40) : "N''"},
  ${cariVar ? yazi("c.TELEFON2", 40) : "N''"},
  ${cariVar ? yazi("c.TELEFON3", 40) : "N''"},
  ${cariVar ? yazi("c.VERGIDAIRESI", 40) : "N''"},
  ${cariVar ? yazi("c.VERGINO", 20) : "N''"},
  CAST(ISNULL(b.ARATOPLAM, 0) AS decimal(18, 2)),
  CAST(ISNULL(b.TUTAR, 0) AS decimal(18, 2)),
  ${yazi("b.PARABIRIMI", 5)},
  CAST(ISNULL(b.KUR, 0) AS decimal(18, 4)),
  CASE WHEN ISNULL(b.IPTAL, 0) = 1 THEN N'1' ELSE N'0' END,
  CASE WHEN ISNULL(b.CONVERTED, 0) = 1 THEN N'1' ELSE N'0' END,
  ${yazi("CAST(b.ALTNOT AS nvarchar(500))", 500)}
FROM ${baslik} b
${cariVar ? `LEFT JOIN ${cari} c ON c.IND = b.FIRMANO` : ""}
WHERE b.IND = ${ind} AND ISNULL(b.BELGETIPI, 0) = 120;
`);
      if (!basSatir.length) return gonder(res, 404, { error: "Teklif bulunamadı." });
      const [belgeInd, tarih, gecerlilik, belge, firmaKod, firmaAd, adres, sehir, telefon, telefon2, telefon3, vergiDaire, vergiNo, ara, tutar, pb, kur, iptal, converted, aciklama] = basSatir[0].split("|").map((part) => part.trim());
      const telefonlar = [telefon, telefon2, telefon3].filter(Boolean);
      let satirlar = [];
      if (await nesneVar(hareket)) {
        const satir = await queryLines(`
SET NOCOUNT ON;
SELECT
  CAST(ISNULL(h.SATIRNO, 0) AS varchar(6)),
  CAST(ISNULL(h.STOKNO, 0) AS varchar(12)),
  ${yazi("h.STOKKODU", 200)},
  ${yazi("h.MALINCINSI", 200)},
  ${yazi("CAST(h.ACIKLAMA AS nvarchar(400))", 400)},
  CAST(ISNULL(h.MIKTAR, 0) AS decimal(18, 2)),
  ${yazi("h.BIRIM", 8)},
  CAST(ISNULL(h.FIYATI, 0) AS decimal(18, 4)),
  CAST(ISNULL(h.ISK1, 0) AS decimal(18, 2)),
  CAST(ISNULL(h.KDV, 0) AS decimal(18, 2)),
  CAST(ISNULL(h.GERCEKTOPLAM, 0) AS decimal(18, 2))
FROM ${hareket} h
WHERE RTRIM(ISNULL(h.EVRAKNO, N'')) = N'${ind}'
ORDER BY ISNULL(h.SATIRNO, 0), h.IND;
`);
        satirlar = satir.map((line, index) => {
          const [no, stok, kod, ad, aciklama, miktar, birim, fiyat, isk, kdv, net] = line.split("|").map((part) => part.trim());
          return {
            no: Number(no) || index + 1,
            stok: Number(stok) || 0,
            kod, ad, aciklama, birim,
            miktar: Number(miktar) || 0,
            fiyat: Number(fiyat) || 0,
            isk: Number(isk) || 0,
            kdv: Number(kdv) || 0,
            tutar: Number(net) || 0,
          };
        });
      }
      const araSayi = Number(ara) || 0;
      const tutarSayi = Number(tutar) || 0;
      gonder(res, 200, {
        ind: Number(belgeInd) || ind,
        tarih, gecerlilik, belge, firmaKod, firmaAd, adres, sehir, telefon, telefonlar, vergiDaire, vergiNo, pb, aciklama,
        ara: araSayi,
        tutar: tutarSayi,
        kdv: Math.max(0, Math.round((tutarSayi - araSayi) * 100) / 100),
        kur: Number(kur) || 0,
        iptal: iptal === "1",
        converted: converted === "1",
        satirlar,
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/teklif-bul") {
      if (!oturum(req)) return gonder(res, 401, { error: "Giriş gerekli." });
      const firma = tamSayi(url.searchParams.get("firma"));
      const tur = url.searchParams.get("tur") === "stok" ? "stok" : "cari";
      const q = ara(url.searchParams.get("q"));
      if (!firma) return gonder(res, 200, { items: [] });
      const kim = oturum(req);
      const donem = tamSayi(kim?.donem);
      const yazi = (ifade, n = 200) => `REPLACE(REPLACE(REPLACE(RTRIM(ISNULL(CAST(${ifade} AS nvarchar(${n})), N'')), N'|', N'/'), CHAR(13), N' '), CHAR(10), N' ')`;
      const like = `%${q}%`;
      if (tur === "cari") {
        const tablo = firmaTablo(firma, "TBLCARI");
        if (!await nesneVar(tablo)) return gonder(res, 200, { items: [] });
        const cariKolon = await kolonKumesi(tablo);
        const hareket = donem ? donemTablo(firma, donem, "TBLCARIHAREKETLERI") : "";
        const hareketVar = hareket && await nesneVar(hareket);
        let bakiyeSelect = "CAST(0 AS decimal(18, 2))";
        let bakiyeJoin = "";
        if (hareketVar) {
          const hareketKolon = await kolonKumesi(hareket);
          const borc = hareketKolon.has("TLBORC") ? "h.TLBORC" : (hareketKolon.has("BORC") ? "h.BORC" : "0");
          const alacak = hareketKolon.has("TLALACAK") ? "h.TLALACAK" : (hareketKolon.has("ALACAK") ? "h.ALACAK" : "0");
          bakiyeJoin = `LEFT JOIN (
  SELECT h.FIRMANO, SUM(ISNULL(${borc}, 0)) - SUM(ISNULL(${alacak}, 0)) AS BAKIYE
  FROM ${hareket} h
  GROUP BY h.FIRMANO
) bak ON bak.FIRMANO = c.IND`;
          bakiyeSelect = "CAST(ISNULL(bak.BAKIYE, 0) AS decimal(18, 2))";
        }
        const kosul = [];
        if (cariKolon.has("DELETED")) kosul.push("ISNULL(c.DELETED, 0) = 0");
        if (q) {
          kosul.push(`(ISNULL(c.FIRMAKODU, N'') COLLATE Latin1_General_CI_AI LIKE N'${like}' OR ISNULL(c.FIRMAADI, N'') COLLATE Latin1_General_CI_AI LIKE N'${like}')`);
        }
        const lines = await queryLines(`
SET NOCOUNT ON;
SELECT TOP 20
  ${yazi("c.FIRMAKODU", 40)},
  ${yazi("c.FIRMAADI", 200)},
  ${yazi("c.ADRESFATURA", 300)},
  ${yazi("c.SEHIR", 40)},
  ${yazi("c.TELEFON1", 40)},
  ${yazi("c.TELEFON2", 40)},
  ${yazi("c.TELEFON3", 40)},
  ${yazi("c.VERGIDAIRESI", 40)},
  ${yazi("c.VERGINO", 20)},
  ${bakiyeSelect}
FROM ${tablo} c
${bakiyeJoin}
${kosul.length ? "WHERE " + kosul.join(" AND ") : ""}
ORDER BY c.FIRMAKODU;
`);
        gonder(res, 200, {
          items: lines.map((line) => {
            const [kod, ad, adres, sehir, telefon, telefon2, telefon3, vergiDaire, vergiNo, bakiye] = line.split("|").map((part) => part.trim());
            const telefonlar = [telefon, telefon2, telefon3].filter(Boolean);
            return { kod, ad, adres, sehir, telefon: telefonlar[0] || "", telefonlar, vergiDaire, vergiNo, bakiye: Number(bakiye) || 0 };
          }).filter((item) => item.kod || item.ad),
        });
        return;
      }
      const stok = firmaTablo(firma, "TBLSTOKLAR");
      const birim = firmaTablo(firma, "TBLBIRIMLEREX");
      if (!await nesneVar(stok)) return gonder(res, 200, { items: [] });
      const stokKolon = await kolonKumesi(stok);
      const birimVar = await nesneVar(birim);
      const envanterSelect = `CAST(${stokKolon.has("KALAN") ? "ISNULL(s.KALAN, 0)" : "0"} AS decimal(18, 2))`;
      const kosul = [];
      if (stokKolon.has("DELETED")) kosul.push("ISNULL(s.DELETED, 0) = 0");
      if (q) {
        kosul.push(`(ISNULL(s.STOKKODU, N'') COLLATE Latin1_General_CI_AI LIKE N'${like}' OR ISNULL(s.MALINCINSI, N'') COLLATE Latin1_General_CI_AI LIKE N'${like}')`);
      }
      const lines = await queryLines(`
SET NOCOUNT ON;
SELECT TOP 20
  CAST(s.IND AS varchar(12)),
  ${yazi("s.STOKKODU", 200)},
  ${yazi("s.MALINCINSI", 200)},
  ${birimVar ? yazi("b.BIRIMADI", 8) : "N'ADET'"},
  ${envanterSelect}
FROM ${stok} s
${birimVar ? `LEFT JOIN ${birim} b ON b.IND = s.BIRIMEX` : ""}
${kosul.length ? "WHERE " + kosul.join(" AND ") : ""}
ORDER BY s.STOKKODU;
`);
      gonder(res, 200, {
        items: lines.map((line) => {
          const [stokNo, kod, ad, birimAd, envanter] = line.split("|").map((part) => part.trim());
          return { stok: Number(stokNo) || 0, kod, ad: ad || kod, birim: birimAd || "ADET", envanter: Number(envanter) || 0 };
        }).filter((item) => item.kod || item.ad),
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/fiyat-teklif") {
      const kim = oturum(req);
      if (!kim) return gonder(res, 401, { error: "Giriş gerekli." });
      const body = await okuGovde(req);
      const firmaNo = tamSayi(kim.firma);
      const donemNo = tamSayi(kim.donem);
      const kod = metin(body.kod, 40).trim();
      const tarih = sqlTarihIfade(body.tarih);
      const gecerlilik = sqlTarihIfade(body.gecerlilik);
      const pb = teklifPbKod(body.pb);
      const kur = sqlOndalik(pb === "TL" ? 1 : (body.kur || 1));
      if (!firmaNo || !donemNo || !kod || !tarih) return gonder(res, 400, { error: "Cari ve tarih gerekli." });
      const hamSatir = (Array.isArray(body.satirlar) ? body.satirlar : []).slice(0, 40);
      const stokTablo = firmaTablo(firmaNo, "TBLSTOKLAR");
      const birimTablo = firmaTablo(firmaNo, "TBLBIRIMLEREX");
      const stokVar = await nesneVar(stokTablo);
      const birimVar = stokVar ? await nesneVar(birimTablo) : "";
      const hamKod = (satir) => String(satir?.kod || "").replace(/[\r\n|]/g, " ").trim().slice(0, 150);
      const kodlar = [...new Set(hamSatir.map((satir) => metin(hamKod(satir), 150)).filter(Boolean))];
      const stokMap = new Map();
      if (stokVar && kodlar.length) {
        const yazi = (ifade) => `REPLACE(REPLACE(REPLACE(RTRIM(ISNULL(CAST(${ifade} AS nvarchar(200)), N'')), N'|', N'/'), CHAR(13), N' '), CHAR(10), N' ')`;
        const bulunan = await queryLines(`
SET NOCOUNT ON;
SELECT
  ${yazi("s.STOKKODU")},
  CAST(s.IND AS varchar(12)),
  CAST(ISNULL(s.BIRIMEX, 0) AS varchar(12)),
  ${birimVar ? yazi("b.BIRIMADI") : "N''"}
FROM ${stokTablo} s
${birimVar ? `LEFT JOIN ${birimTablo} b ON b.IND = s.BIRIMEX` : ""}
WHERE s.STOKKODU IN (${kodlar.map((item) => `N'${item}'`).join(", ")});
`);
        for (const line of bulunan) {
          const [stokKod, stokInd, birimex, birimAd] = line.split("|").map((part) => part.trim());
          if (stokKod) stokMap.set(stokKod.toLocaleUpperCase("tr"), { ind: Number(stokInd) || 0, birimex: Number(birimex) || 0, birim: (birimAd || "").slice(0, 5) });
        }
      }
      const temizSatir = [];
      for (const satir of hamSatir) {
        const miktar = Number(satir?.miktar);
        const fiyat = Number(satir?.fiyat);
        if (!(miktar > 0) || !Number.isFinite(fiyat) || fiyat < 0) continue;
        const isk = Math.min(100, Math.max(0, Number(satir?.isk) || 0));
        const kdvOran = Math.min(100, Math.max(0, Number(satir?.kdv) || 0));
        const net = Math.round(miktar * fiyat * (1 - isk / 100) * 100) / 100;
        const kdvTutar = Math.round(net * kdvOran) / 100;
        const stokKod = hamKod(satir);
        const kart = stokMap.get(stokKod.toLocaleUpperCase("tr"));
        const ad = String(satir?.ad || stokKod).replace(/[\r\n|]/g, " ").trim().slice(0, 200) || stokKod;
        temizSatir.push({
          stok: kart?.ind || 0,
          kod: (stokKod || ad).slice(0, 200),
          ad: ad.slice(0, 200),
          aciklama: String(satir?.aciklama || "").replace(/[\r\n|']/g, " ").trim().slice(0, 400),
          miktar: sqlOndalik(miktar),
          birim: metin(kart?.birim || satir?.birim || "ADET", 5).trim() || "ADET",
          birimex: kart?.birimex || 0,
          fiyat: sqlOndalik(fiyat),
          isk: sqlOndalik(isk),
          kdv: sqlOndalik(kdvOran),
          net: sqlOndalik(net),
          kdvTutar: sqlOndalik(kdvTutar),
          netSayi: net,
          kdvSayi: kdvTutar,
        });
      }
      if (!temizSatir.length) return gonder(res, 400, { error: "En az bir tutarlı satır gerekli." });
      const araToplam = temizSatir.reduce((sum, satir) => sum + satir.netSayi, 0);
      const kdvToplam = temizSatir.reduce((sum, satir) => sum + satir.kdvSayi, 0);
      const genel = Math.round((araToplam + kdvToplam) * 100) / 100;
      const baslik = donemTablo(firmaNo, donemNo, "TBLPROFATBASLIK");
      const hareket = donemTablo(firmaNo, donemNo, "TBLPROFATHAREKET");
      const cari = firmaTablo(firmaNo, "TBLCARI");
      const depo = firmaTablo(firmaNo, "TBLDEPOLAR");
      if (!await nesneVar(baslik) || !await nesneVar(hareket)) return gonder(res, 400, { error: "Teklif tablosu bulunamadı." });
      const depoVar = await nesneVar(depo);
      const baslikKolon = await kolonKumesi(baslik);
      const vegaAlan = [
        ["UID", "NEWID()"],
        ["AK", "0"],
        ["STATUS", "1"],
        ["SATISSEKLI", "0"],
        ["ENTEGRE", "0"],
        ["KAYNAK", "0"],
      ].filter(([ad]) => baslikKolon.has(ad));
      const satirSql = temizSatir.map((satir, index) => `
INSERT INTO ${hareket} (
  TARIH, EVRAKNO, FIRMANO, STOKNO, STOKKODU, MALINCINSI, ACIKLAMA, MIKTAR, BIRIMMIKTAR,
  BIRIM, BIRIMEX, KDV, ISK1, FIYATI, AFIYATI, GERCEKTOPLAM, KDVTUTARI,
  DEPO, PARABIRIMI, KUR, SATIRNO
) VALUES (
  ${tarih}, CAST(@ind AS nvarchar(20)), @firma, ${satir.stok},
  N'${metin(satir.kod, 200)}', N'${metin(satir.ad, 200)}', N'${metin(satir.aciklama, 400)}', ${satir.miktar}, ${satir.miktar},
  N'${satir.birim}', ${satir.birimex || "NULL"}, ${satir.kdv}, ${satir.isk},
  ${satir.fiyat}, ${satir.fiyat}, ${satir.net}, ${satir.kdvTutar},
  @depo, N'${pb}', ${kur}, ${index + 1}
);`).join("");
      const sql = `
SET NOCOUNT ON;
SET XACT_ABORT ON;
BEGIN TRY
  BEGIN TRAN;
  DECLARE @firma int, @ind int, @sira int, @belge nvarchar(20), @depo int;
  SELECT TOP 1 @firma = IND
  FROM ${cari}
  WHERE FIRMAKODU COLLATE Turkish_CI_AS = N'${kod}'
  ORDER BY IND;
  IF @firma IS NULL
  BEGIN
    ROLLBACK;
    SELECT N'hata|Cari bulunamadı';
    RETURN;
  END
  ${depoVar ? `SELECT TOP 1 @depo = IND FROM ${depo} ORDER BY IND;` : "SET @depo = NULL;"}
  SELECT @sira = ISNULL(MAX(CONVERT(int, SUBSTRING(BELGENO, 2, 16))), 0) + 1
  FROM ${baslik} WITH (UPDLOCK, HOLDLOCK)
  WHERE BELGENO LIKE N'A' + REPLICATE(N'[0-9]', 7);
  SET @belge = N'A' + RIGHT(REPLICATE(N'0', 7) + CAST(@sira AS nvarchar(10)), CASE WHEN LEN(CAST(@sira AS nvarchar(10))) > 7 THEN LEN(CAST(@sira AS nvarchar(10))) ELSE 7 END);
  INSERT INTO ${baslik} (
    FIRMANO, FIRMAADI, BELGENO, TARIH, TUTAR, ARATOPLAM, PARABIRIMI, KUR,
    BELGETIPI, IPTAL, GIRIS, CONVERTED, KDV, CREDATE, USERNO, HAREKETDEPOSU,
    OZELKOD1, ALTNOT, SONGECERLILIKTARIHI${vegaAlan.length ? ", " + vegaAlan.map(([ad]) => ad).join(", ") : ""}
  ) VALUES (
    @firma, LEFT(N'${metin(body.firmaAd, 40)}', 20), @belge, ${tarih}, ${sqlOndalik(genel)}, ${sqlOndalik(araToplam)}, N'${pb}', ${kur},
    120, 0, 0, 0, 0, GETDATE(), ${tamSayi(kim.no, 999999) || 0}, @depo,
    N'${metin(body.sube || "MERKEZ", 15)}', ${body.aciklama ? `N'${metin(body.aciklama, 500)}'` : "NULL"}, ${gecerlilik || "NULL"}${vegaAlan.length ? ", " + vegaAlan.map(([, deger]) => deger).join(", ") : ""}
  );
  SET @ind = SCOPE_IDENTITY();
  ${satirSql}
  COMMIT;
  SELECT N'ok|' + @belge + N'|' + CAST(@ind AS nvarchar(20));
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK;
  SELECT N'hata|' + REPLACE(REPLACE(ERROR_MESSAGE(), N'|', N'/'), NCHAR(13), N' ');
END CATCH;
`;
      const sonuc = await queryLines(sql);
      const parca = (sonuc[0] || "").split("|");
      if (parca[0] !== "ok") return gonder(res, 400, { error: parca.slice(1).join("|") || "Teklif yazılamadı." });
      gonder(res, 200, { belgeNo: parca[1], belgeInd: Number(parca[2]) || 0, satirlar: temizSatir.map((satir, index) => ({ no: index + 1, stok: satir.stok })) });
      return;
    }

    if (req.method === "PUT" && url.pathname === "/api/fiyat-teklif") {
      const kim = oturum(req);
      if (!kim) return gonder(res, 401, { error: "Giriş gerekli." });
      const body = await okuGovde(req);
      const firmaNo = tamSayi(kim.firma);
      const donemNo = tamSayi(kim.donem);
      const ind = tamSayi(body.ind);
      const kod = metin(body.kod, 40).trim();
      const tarih = sqlTarihIfade(body.tarih);
      const gecerlilik = sqlTarihIfade(body.gecerlilik);
      const pb = teklifPbKod(body.pb);
      const kur = sqlOndalik(pb === "TL" ? 1 : (body.kur || 1));
      if (!firmaNo || !donemNo || !ind || !kod || !tarih) return gonder(res, 400, { error: "Teklif, cari ve tarih gerekli." });
      const hamSatir = (Array.isArray(body.satirlar) ? body.satirlar : []).slice(0, 40);
      const stokTablo = firmaTablo(firmaNo, "TBLSTOKLAR");
      const birimTablo = firmaTablo(firmaNo, "TBLBIRIMLEREX");
      const stokVar = await nesneVar(stokTablo);
      const birimVar = stokVar ? await nesneVar(birimTablo) : "";
      const hamKod = (satir) => String(satir?.kod || "").replace(/[\r\n|]/g, " ").trim().slice(0, 150);
      const kodlar = [...new Set(hamSatir.map((satir) => metin(hamKod(satir), 150)).filter(Boolean))];
      const stokMap = new Map();
      if (stokVar && kodlar.length) {
        const yazi = (ifade) => `REPLACE(REPLACE(REPLACE(RTRIM(ISNULL(CAST(${ifade} AS nvarchar(200)), N'')), N'|', N'/'), CHAR(13), N' '), CHAR(10), N' ')`;
        const bulunan = await queryLines(`
SET NOCOUNT ON;
SELECT
  ${yazi("s.STOKKODU")},
  CAST(s.IND AS varchar(12)),
  CAST(ISNULL(s.BIRIMEX, 0) AS varchar(12)),
  ${birimVar ? yazi("b.BIRIMADI") : "N''"}
FROM ${stokTablo} s
${birimVar ? `LEFT JOIN ${birimTablo} b ON b.IND = s.BIRIMEX` : ""}
WHERE s.STOKKODU IN (${kodlar.map((item) => `N'${item}'`).join(", ")});
`);
        for (const line of bulunan) {
          const [stokKod, stokInd, birimex, birimAd] = line.split("|").map((part) => part.trim());
          if (stokKod) stokMap.set(stokKod.toLocaleUpperCase("tr"), { ind: Number(stokInd) || 0, birimex: Number(birimex) || 0, birim: (birimAd || "").slice(0, 5) });
        }
      }
      const temizSatir = [];
      for (const satir of hamSatir) {
        const miktar = Number(satir?.miktar);
        const fiyat = Number(satir?.fiyat);
        if (!(miktar > 0) || !Number.isFinite(fiyat) || fiyat < 0) continue;
        const isk = Math.min(100, Math.max(0, Number(satir?.isk) || 0));
        const kdvOran = Math.min(100, Math.max(0, Number(satir?.kdv) || 0));
        const net = Math.round(miktar * fiyat * (1 - isk / 100) * 100) / 100;
        const kdvTutar = Math.round(net * kdvOran) / 100;
        const stokKod = hamKod(satir);
        const kart = stokMap.get(stokKod.toLocaleUpperCase("tr"));
        const ad = String(satir?.ad || stokKod).replace(/[\r\n|']/g, " ").trim().slice(0, 200) || stokKod;
        const aciklama = String(satir?.aciklama || "").replace(/[\r\n|']/g, " ").trim().slice(0, 400);
        temizSatir.push({
          stok: kart?.ind || 0,
          kod: (stokKod || ad).slice(0, 200),
          ad: ad.slice(0, 200),
          aciklama,
          miktar: sqlOndalik(miktar),
          birim: metin(kart?.birim || satir?.birim || "ADET", 5).trim() || "ADET",
          birimex: kart?.birimex || 0,
          fiyat: sqlOndalik(fiyat),
          isk: sqlOndalik(isk),
          kdv: sqlOndalik(kdvOran),
          net: sqlOndalik(net),
          kdvTutar: sqlOndalik(kdvTutar),
          netSayi: net,
          kdvSayi: kdvTutar,
        });
      }
      if (!temizSatir.length) return gonder(res, 400, { error: "En az bir tutarlı satır gerekli." });
      const araToplam = temizSatir.reduce((sum, satir) => sum + satir.netSayi, 0);
      const kdvToplam = temizSatir.reduce((sum, satir) => sum + satir.kdvSayi, 0);
      const genel = Math.round((araToplam + kdvToplam) * 100) / 100;
      const baslik = donemTablo(firmaNo, donemNo, "TBLPROFATBASLIK");
      const hareket = donemTablo(firmaNo, donemNo, "TBLPROFATHAREKET");
      const cari = firmaTablo(firmaNo, "TBLCARI");
      const depo = firmaTablo(firmaNo, "TBLDEPOLAR");
      if (!await nesneVar(baslik) || !await nesneVar(hareket)) return gonder(res, 400, { error: "Teklif tablosu bulunamadı." });
      const depoVar = await nesneVar(depo);
      const baslikKolon = await kolonKumesi(baslik);
      const vegaGuncelle = [
        ["UID", "ISNULL(UID, NEWID())"],
        ["AK", "0"],
        ["STATUS", "ISNULL(STATUS, 1)"],
        ["SATISSEKLI", "ISNULL(SATISSEKLI, 0)"],
        ["ENTEGRE", "ISNULL(ENTEGRE, 0)"],
        ["KAYNAK", "ISNULL(KAYNAK, 0)"],
      ].filter(([ad]) => baslikKolon.has(ad)).map(([ad, deger]) => `${ad} = ${deger}`).join(",\n      ");
      const satirSql = temizSatir.map((satir, index) => `
INSERT INTO ${hareket} (
  TARIH, EVRAKNO, FIRMANO, STOKNO, STOKKODU, MALINCINSI, ACIKLAMA, MIKTAR, BIRIMMIKTAR,
  BIRIM, BIRIMEX, KDV, ISK1, FIYATI, AFIYATI, GERCEKTOPLAM, KDVTUTARI,
  DEPO, PARABIRIMI, KUR, SATIRNO
) VALUES (
  ${tarih}, CAST(@ind AS nvarchar(20)), @firma, ${satir.stok},
  N'${metin(satir.kod, 200)}', N'${metin(satir.ad, 200)}', N'${metin(satir.aciklama || "", 400)}', ${satir.miktar}, ${satir.miktar},
  N'${satir.birim}', ${satir.birimex || "NULL"}, ${satir.kdv}, ${satir.isk},
  ${satir.fiyat}, ${satir.fiyat}, ${satir.net}, ${satir.kdvTutar},
  @depo, N'${pb}', ${kur}, ${index + 1}
);`).join("");
      const sql = `
SET NOCOUNT ON;
SET XACT_ABORT ON;
BEGIN TRY
  BEGIN TRAN;
  DECLARE @firma int, @ind int, @belge nvarchar(20), @depo int, @iptal int, @converted int;
  SET @ind = ${ind};
  SELECT @belge = BELGENO, @iptal = ISNULL(IPTAL, 0), @converted = ISNULL(CONVERTED, 0)
  FROM ${baslik} WITH (UPDLOCK, HOLDLOCK)
  WHERE IND = @ind AND ISNULL(BELGETIPI, 0) = 120;
  IF @belge IS NULL
  BEGIN
    ROLLBACK;
    SELECT N'hata|Teklif bulunamadı';
    RETURN;
  END
  IF @iptal = 1 OR @converted = 1
  BEGIN
    ROLLBACK;
    SELECT N'hata|İptal veya faturalanmış teklif düzenlenemez';
    RETURN;
  END
  SELECT TOP 1 @firma = IND
  FROM ${cari}
  WHERE FIRMAKODU COLLATE Turkish_CI_AS = N'${kod}'
  ORDER BY IND;
  IF @firma IS NULL
  BEGIN
    ROLLBACK;
    SELECT N'hata|Cari bulunamadı';
    RETURN;
  END
  ${depoVar ? `SELECT TOP 1 @depo = IND FROM ${depo} ORDER BY IND;` : "SET @depo = NULL;"}
  UPDATE ${baslik}
  SET FIRMANO = @firma,
      FIRMAADI = LEFT(N'${metin(body.firmaAd, 40)}', 20),
      TARIH = ${tarih},
      TUTAR = ${sqlOndalik(genel)},
      ARATOPLAM = ${sqlOndalik(araToplam)},
      PARABIRIMI = N'${pb}',
      KUR = ${kur},
      ALTNOT = ${body.aciklama ? `N'${metin(body.aciklama, 500)}'` : "NULL"},
      SONGECERLILIKTARIHI = ${gecerlilik || "NULL"},
      OZELKOD1 = N'${metin(body.sube || "MERKEZ", 15)}',
      HAREKETDEPOSU = @depo${vegaGuncelle ? ",\n      " + vegaGuncelle : ""}
  WHERE IND = @ind;
  DELETE FROM ${hareket} WHERE RTRIM(ISNULL(EVRAKNO, N'')) = CAST(@ind AS nvarchar(20));
  ${satirSql}
  COMMIT;
  SELECT N'ok|' + @belge + N'|' + CAST(@ind AS nvarchar(20));
END TRY
BEGIN CATCH
  IF @@TRANCOUNT > 0 ROLLBACK;
  SELECT N'hata|' + REPLACE(REPLACE(ERROR_MESSAGE(), N'|', N'/'), NCHAR(13), N' ');
END CATCH;
`;
      const sonuc = await queryLines(sql);
      const parca = (sonuc[0] || "").split("|");
      if (parca[0] !== "ok") return gonder(res, 400, { error: parca.slice(1).join("|") || "Teklif güncellenemedi." });
      gonder(res, 200, { belgeNo: parca[1], belgeInd: Number(parca[2]) || ind, guncelle: true, satirlar: temizSatir.map((satir, index) => ({ no: index + 1, stok: satir.stok })) });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/islem-kasa") {
      if (!oturum(req)) return gonder(res, 401, { error: "Giriş gerekli." });
      const firma = tamSayi(url.searchParams.get("firma"));
      const donem = tamSayi(url.searchParams.get("donem"));
      const tarihIfade = sqlTarihIfade(url.searchParams.get("tarih"));
      const sube = metin(url.searchParams.get("sube"), 80).trim();
      const kasaAd = metin(url.searchParams.get("kasa"), 80).trim();
      if (!firma || !donem || !tarihIfade) return gonder(res, 400, { error: "Firma, dönem ve tarih seçin." });
      const hareket = await nesneVar(donemTablo(firma, donem, "TBLKASA"));
      const gorunum = await nesneVar(donemTablo(firma, donem, "VARESISLEMKASASI"));
      const subeTablo = await nesneVar(firmaTablo(firma, "TBLSUBELER"));
      if (!hareket && !gorunum) return gonder(res, 200, { items: [], gelir: 0, gider: 0, son: 0, subeler: [], kasalar: [] });
      const kaynak = hareket || gorunum;
      const kolon = await kolonKumesi(kaynak);
      const nakit = kolon.has("ISLEMTIPI")
        ? (hareket ? "ISNULL(k.ISLEMTIPI, 0) = 1" : "RTRIM(ISNULL(k.ISLEMTIPI, N'')) = N'Nakit'")
        : "1 = 1";
      const temiz = (ifade) => `REPLACE(REPLACE(REPLACE(RTRIM(ISNULL(CAST(${ifade} AS nvarchar(200)), N'')), N'|', N'/'), CHAR(13), N' '), CHAR(10), N' ')`;
      const kosullar = [nakit];
      if (sube && kolon.has("SUBEADI")) kosullar.push(`RTRIM(ISNULL(k.SUBEADI, N'')) = N'${sube}'`);
      if (kasaAd && kolon.has("KASAADI")) kosullar.push(`RTRIM(ISNULL(k.KASAADI, N'')) = N'${kasaAd}'`);
      const where = kosullar.join(" AND ");
      const gun = `k.TARIH >= ${tarihIfade} AND k.TARIH < DATEADD(day, 1, ${tarihIfade})`;
      const sinir = `k.TARIH < DATEADD(day, 1, ${tarihIfade})`;
      const gelirAlan = kolon.has("GELIR") ? "k.GELIR" : "k.TLGELIR";
      const giderAlan = kolon.has("GIDER") ? "k.GIDER" : "k.TLGIDER";
      const baglar = [`FROM ${kaynak} k`];
      if (hareket && gorunum) baglar.push(`LEFT JOIN ${gorunum} v ON v.IND = k.IND`);
      if (kolon.has("USERNO")) baglar.push("LEFT JOIN TBLUSERS u ON u.IND = k.USERNO");
      const from = baglar.join("\n");
      const islemNo = hareket && gorunum
        ? `COALESCE(NULLIF(${temiz("v.BELGENO")}, N''), ${temiz(kolon.has("EVRAKNO") ? "k.EVRAKNO" : "N''")})`
        : temiz(kolon.has("BELGENO") ? "k.BELGENO" : (kolon.has("EVRAKNO") ? "k.EVRAKNO" : "N''"));
      const islem = hareket && gorunum ? temiz("v.KASAISLEM") : temiz(kolon.has("KASAISLEM") ? "k.KASAISLEM" : "N''");
      const kullanici = kolon.has("USERNO")
        ? (hareket && gorunum
          ? `COALESCE(NULLIF(${temiz("v.USERNAME")}, N''), ${temiz("u.USERNAME")})`
          : temiz("u.USERNAME"))
        : temiz(kolon.has("USERNAME") ? "k.USERNAME" : "N''");
      const lines = await queryLines(`
SET NOCOUNT ON;
SELECT
  CONVERT(varchar(10), k.TARIH, 104),
  ${temiz(kolon.has("ACIKLAMA") ? "k.ACIKLAMA" : "N''")},
  ${islemNo},
  ${islem},
  CAST(ISNULL(${gelirAlan}, 0) AS decimal(18, 2)),
  CAST(ISNULL(${giderAlan}, 0) AS decimal(18, 2)),
  ${temiz(kolon.has("SUBEADI") ? "k.SUBEADI" : "N''")},
  ${temiz(kolon.has("KASAADI") ? "k.KASAADI" : "N''")},
  ${temiz(kolon.has("BELGENEVI") ? "k.BELGENEVI" : "N''")},
  ${kullanici}
${from}
WHERE ${where} AND ${gun}
ORDER BY k.TARIH, k.IND;
`);
      const ozetSatir = await queryLines(`
SET NOCOUNT ON;
SELECT
  CAST(ISNULL(SUM(CASE WHEN ${gun} THEN ISNULL(${gelirAlan}, 0) ELSE 0 END), 0) AS decimal(18, 2)),
  CAST(ISNULL(SUM(CASE WHEN ${gun} THEN ISNULL(${giderAlan}, 0) ELSE 0 END), 0) AS decimal(18, 2)),
  CAST(ISNULL(SUM(ISNULL(${gelirAlan}, 0) - ISNULL(${giderAlan}, 0)), 0) AS decimal(18, 2))
${from}
WHERE ${where} AND ${sinir};
`);
      const tanimParcasi = [];
      if (subeTablo) {
        tanimParcasi.push(`SELECT DISTINCT N'sube', RTRIM(ISNULL(SUBEAD, N'')) FROM ${subeTablo} WHERE RTRIM(ISNULL(SUBEAD, N'')) <> N''`);
      } else if (kolon.has("SUBEADI")) {
        tanimParcasi.push(`SELECT DISTINCT N'sube', RTRIM(ISNULL(SUBEADI, N'')) FROM ${kaynak} WHERE RTRIM(ISNULL(SUBEADI, N'')) <> N''`);
      }
      if (kolon.has("KASAADI")) {
        tanimParcasi.push(`SELECT DISTINCT N'kasa', RTRIM(ISNULL(KASAADI, N'')) FROM ${kaynak} WHERE RTRIM(ISNULL(KASAADI, N'')) <> N''`);
      }
      const tanimlar = tanimParcasi.length
        ? await queryLines(`SET NOCOUNT ON;\n${tanimParcasi.join("\nUNION ALL\n")};`)
        : [];
      const subeler = [];
      const kasalar = [];
      for (const line of tanimlar) {
        const [tur, ad] = line.split("|").map((part) => part.trim());
        if (!ad) continue;
        if (tur === "sube" && !subeler.includes(ad)) subeler.push(ad);
        if (tur === "kasa" && !kasalar.includes(ad)) kasalar.push(ad);
      }
      subeler.sort((a, b) => a.localeCompare(b, "tr"));
      kasalar.sort((a, b) => a.localeCompare(b, "tr"));
      const [gelir, gider, son] = (ozetSatir[0] || "0|0|0").split("|").map((part) => Number(part) || 0);
      const items = lines.map((line) => {
        const [tarih, aciklama, islemNoDeger, islemAd, giren, cikan, subeAdi, kasaAdi, belgeNevi, kullaniciAd] = line.split("|").map((part) => part.trim());
        return {
          tarih,
          aciklama,
          islemNo: islemNoDeger,
          islem: islemAd,
          giren: Number(giren) || 0,
          cikan: Number(cikan) || 0,
          sube: subeAdi,
          kasa: kasaAdi,
          belgeNevi,
          kullanici: kullaniciAd,
        };
      });
      gonder(res, 200, { items, gelir, gider, son, subeler, kasalar });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/portfoy") {
      if (!oturum(req)) return gonder(res, 401, { error: "Giriş gerekli." });
      const firma = tamSayi(url.searchParams.get("firma"));
      const donem = tamSayi(url.searchParams.get("donem"));
      const bas = sqlTarihIfade(url.searchParams.get("bas"));
      const bit = sqlTarihIfade(url.searchParams.get("bit"));
      const tur = String(url.searchParams.get("tur") || "");
      const tanim = {
        cek: { view: "VARESALINANCEKLER", islem: "CEKISLEM", izahat: 2 },
        senet: { view: "VARESALINANSENETLER", islem: "SENETISLEM", izahat: 6 },
        visa: { view: "VARESALINANKREDIKARTI", islem: "KARTISLEM", izahat: 4 },
      }[tur];
      if (!firma || !donem || !bas || !bit || !tanim) return gonder(res, 400, { error: "Firma, dönem ve tarih seçin." });
      const view = await nesneVar(donemTablo(firma, donem, tanim.view));
      if (!view) return gonder(res, 200, { items: [], toplam: 0, durumlar: [] });
      const [kolon, girisBaslikAd] = await Promise.all([
        kolonKumesi(view),
        nesneVar(donemTablo(firma, donem, "TBLCARGIRBASLIK")),
      ]);
      const listeTarih = kolon.has("VADE") ? "VADE" : (kolon.has("TARIH") ? "TARIH" : "VADE");
      const durumAlan = kolon.has(tanim.islem) ? tanim.islem : "";
      const secilen = [...new Set(String(url.searchParams.get("durum") || "").split(",").map((parca) => metin(parca, 80).trim()).filter(Boolean))].slice(0, 30);
      const tarihAlanlari = ["TARIH", "VADE", "SONISLEMTARIHI"].filter((ad) => kolon.has(ad));
      const tarihKosulu = tarihAlanlari.length
        ? "(" + tarihAlanlari.map((ad) => `(k.${ad} >= ${bas} AND k.${ad} < DATEADD(day, 1, ${bit}))`).join(" OR ") + ")"
        : "1 = 1";
      const kosullar = [tarihKosulu];
      if (durumAlan && secilen.length) {
        kosullar.push(`RTRIM(ISNULL(k.${durumAlan}, N'')) IN (${secilen.map((ad) => `N'${ad}'`).join(", ")})`);
      }
      const temiz = (ifade) => `REPLACE(REPLACE(REPLACE(RTRIM(ISNULL(CAST(${ifade} AS nvarchar(200)), N'')), N'|', N'/'), CHAR(13), N' '), CHAR(10), N' ')`;
      const yaziKolon = (ad) => kolon.has(ad) ? temiz(`k.${ad}`) : "N''";
      const sayiKolon = (ad) => kolon.has(ad) ? `CAST(ISNULL(k.${ad}, 0) AS decimal(18, 2))` : "CAST(0 AS decimal(18, 2))";
      const belgeKaynak = kolon.has("BELGENO") ? yaziKolon("BELGENO") : "N''";
      const girisBaslik = kolon.has("BASIND") ? girisBaslikAd : "";
      const belgeIfade = girisBaslik
        ? `CASE WHEN ${belgeKaynak} <> N'' THEN ${belgeKaynak} ELSE ${temiz("g.BELGENO")} END`
        : belgeKaynak;
      const [lines, durumSatir] = await Promise.all([
        queryLines(`
SET NOCOUNT ON;
SELECT
  CONVERT(varchar(10), k.${listeTarih}, 104),
  ${belgeIfade},
  ${yaziKolon("FIRMAADI")},
  ${yaziKolon("KESIDEEDEN")},
  ${durumAlan ? yaziKolon(durumAlan) : "N''"},
  ${yaziKolon("TAKASTAHSILBANKAADI")},
  ${kolon.has("TAKASTAHSILBANKAADI") ? "N''" : yaziKolon("BANKAADI")},
  ${yaziKolon("CIROEDILENFIRMAADI")},
  ${sayiKolon("TUTAR")},
  ${kolon.has("BASIND") ? "CAST(ISNULL(k.BASIND, 0) AS varchar(12))" : "N'0'"},
  ${kolon.has("PORTNO") ? "CAST(ISNULL(k.PORTNO, 0) AS varchar(12))" : "N'0'"},
  ${kolon.has("BELGETIPI") ? "CAST(ISNULL(k.BELGETIPI, 13) AS varchar(6))" : "N'13'"}
FROM ${view} k
${girisBaslik ? `LEFT JOIN ${girisBaslik} g ON g.IND = k.BASIND` : ""}
WHERE ${kosullar.join(" AND ")}
ORDER BY k.${listeTarih} ASC${kolon.has("BELGENO") ? ", k.BELGENO" : ""};
`),
        durumAlan
          ? queryLines(`
SET NOCOUNT ON;
SELECT DISTINCT N'd', ${temiz(`k.${durumAlan}`)}
FROM ${view} k
WHERE ${tarihKosulu}
  AND RTRIM(ISNULL(k.${durumAlan}, N'')) <> N'';
`)
          : Promise.resolve([]),
      ]);
      const durumlar = durumSatir.map((line) => (line.split("|")[1] || "").trim()).filter(Boolean).sort((a, b) => a.localeCompare(b, "tr"));
      const items = lines.map((line) => {
        const [vade, belge, firmaAdi, keside, durum, takasBanka, kartBanka, ciro, tutar, basInd, portNoDeger, belgeTipi] = line.split("|");
        return {
          vade: (vade || "").trim(),
          belge: (belge || "").trim(),
          firma: (firmaAdi || "").trim(),
          keside: (keside || "").trim(),
          durum: (durum || "").trim(),
          banka: ((takasBanka || "").trim() || (kartBanka || "").trim()),
          ciro: (ciro || "").trim(),
          tutar: Number((tutar || "").trim()) || 0,
          basInd: Number((basInd || "").trim()) || 0,
          portNo: Number((portNoDeger || "").trim()) || 0,
          belgeTipi: Number((belgeTipi || "").trim()) || 13,
          gorseller: [],
        };
      });
      try {
        const baslik = girisBaslikAd;
        if (baslik && items.some((item) => item.basInd)) {
          const nolar = [...new Set(items.map((item) => item.basInd).filter((no) => no > 0))].slice(0, 400);
          const uidSatir = await queryLines(`
SET NOCOUNT ON;
SELECT
  CAST(b.IND AS varchar(12)),
  UPPER(REPLACE(REPLACE(RTRIM(CAST(b.UID AS nvarchar(40))), N'{', N''), N'}', N''))
FROM ${baslik} b
WHERE b.IND IN (${nolar.join(", ")}) AND b.UID IS NOT NULL;
`);
          const indGuid = new Map();
          const guidler = [];
          for (const line of uidSatir) {
            const [ind, guid] = line.split("|").map((part) => part.trim());
            if (!guid) continue;
            indGuid.set(Number(ind), guid);
            guidler.push(guid);
          }
          if (guidler.length) {
            const tekil = [...new Set(guidler)].slice(0, 400);
            const liste = tekil.map((guid) => `N'${guid.replace(/'/g, "''")}'`).join(", ");
            const dokuman = await queryLines(`
SET NOCOUNT ON;
SELECT
  UPPER(REPLACE(REPLACE(RTRIM(OwnerGuid), N'{', N''), N'}', N'')),
  CAST(Id AS varchar(12)),
  RTRIM(REPLACE(ISNULL(Name, N''), N'|', N'/'))
FROM VegaDocuments.dbo.Documents
WHERE ISNULL(Deleted, 0) = 0
  AND UPPER(REPLACE(REPLACE(RTRIM(OwnerGuid), N'{', N''), N'}', N'')) IN (${liste});
`);
            const guidGorsel = new Map();
            for (const line of dokuman) {
              const [guid, id, ad] = line.split("|").map((part) => part.trim());
              const kayit = guidGorsel.get(guid) || [];
              kayit.push({ id: Number(id) || 0, ad });
              guidGorsel.set(guid, kayit);
            }
            for (const item of items) {
              const guid = indGuid.get(item.basInd);
              if (guid) item.gorseller = guidGorsel.get(guid) || [];
            }
          }
        }
      } catch { /* taranmış belge yok */ }
      const toplam = items.reduce((sum, item) => sum + item.tutar, 0);
      gonder(res, 200, {
        items: items.map(({ portNo, ...item }) => item),
        toplam,
        durumlar,
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/odeme-takvim") {
      if (!oturum(req)) return gonder(res, 401, { error: "Giriş gerekli." });
      const firma = tamSayi(url.searchParams.get("firma"));
      const donem = tamSayi(url.searchParams.get("donem"));
      const ayYazi = String(url.searchParams.get("ay") || "").trim();
      const ayEsles = ayYazi.match(/^(\d{4})-(\d{2})$/);
      if (!firma || !donem || !ayEsles) return gonder(res, 400, { error: "Firma, dönem ve ay seçin." });
      const yil = Number(ayEsles[1]);
      const ay = Number(ayEsles[2]);
      if (ay < 1 || ay > 12) return gonder(res, 400, { error: "Geçersiz ay." });
      const ciroDahil = url.searchParams.get("ciro") === "1";
      const basGun = yil + "-" + String(ay).padStart(2, "0") + "-01";
      const bitTarih = new Date(yil, ay, 0);
      const bitGun = bitTarih.getFullYear() + "-" + String(bitTarih.getMonth() + 1).padStart(2, "0") + "-" + String(bitTarih.getDate()).padStart(2, "0");
      const kayitlar = await odemeTakvimKayitlariGetir(firma, donem, basGun, bitGun, ciroDahil);
      const gunler = {};
      for (const kayit of kayitlar) {
        if (!gunler[kayit.gun]) gunler[kayit.gun] = [];
        gunler[kayit.gun].push({
          tur: kayit.tur,
          yon: kayit.yon,
          firma: kayit.firma,
          keside: kayit.keside,
          belge: kayit.belge,
          tutar: kayit.tutar,
          durum: kayit.durum,
          takas: kayit.takas,
        });
      }
      gonder(res, 200, { ay: ayYazi, gunler });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/hatirlatma") {
      const kim = oturum(req);
      if (!kim) return gonder(res, 401, { error: "Giriş gerekli." });
      if (kim.firma && kim.donem) googleBaglamYaz({ firma: kim.firma, donem: kim.donem });
      try { await teklifHatirlatmaOtomatik(); } catch { /* teklif okunamazsa mevcut notlar döner */ }
      gonder(res, 200, { items: hatirlatmalariOku() });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/hatirlatma") {
      if (!oturum(req)) return gonder(res, 401, { error: "Giriş gerekli." });
      const body = await okuGovde(req);
      const gun = String(body.gun || "").trim();
      const saat = String(body.saat || "09:00").trim() || "09:00";
      const metin = String(body.metin || "").trim().slice(0, 500);
      const idGelen = String(body.id || "").trim();
      const onceGun = Math.min(30, Math.max(0, Number(body.onceGun) || 0));
      if (!/^\d{4}-\d{2}-\d{2}$/.test(gun) || !metin) {
        return gonder(res, 400, { error: "Tarih ve not gerekli." });
      }
      if (!/^\d{2}:\d{2}$/.test(saat)) return gonder(res, 400, { error: "Saat geçersiz." });
      const liste = hatirlatmalariOku();
      let item = idGelen ? liste.find((row) => row.id === idGelen) : null;
      if (item && item.onceAnaId) {
        return gonder(res, 400, { error: "Bu kayıt gün-önce uyarısıdır; ana hatırlatmayı düzenleyin." });
      }
      if (item) {
        item.gun = gun;
        item.saat = saat;
        item.metin = metin;
        item.onceGun = onceGun;
        item.gonderildi = false;
        item.guncelleme = new Date().toISOString();
      } else {
        item = {
          id: randomBytes(6).toString("hex"),
          gun,
          saat,
          metin,
          onceGun,
          gonderildi: false,
          olusturma: new Date().toISOString(),
          guncelleme: new Date().toISOString(),
        };
        liste.push(item);
      }
      const plan = hatirlatmaOnceBagliSenkron(liste, item);
      hatirlatmalariYaz(liste);
      hatirlatmaGorevleriniArkaPlanda(plan.silinecek, [item, ...plan.kurulacak]);
      gonder(res, 200, { item, items: liste });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/hatirlatma-toplu") {
      if (!oturum(req)) return gonder(res, 401, { error: "Giriş gerekli." });
      const body = await okuGovde(req);
      const saat = String(body.saat || "09:00").trim() || "09:00";
      const metin = String(body.metin || "").trim().slice(0, 500);
      const baslangic = String(body.baslangic || "").trim();
      const periyot = String(body.periyot || "aylik").trim();
      const yilBoyu = Boolean(body.yilBoyu);
      let bitis = String(body.bitis || "").trim();
      const ayGunu = Math.min(31, Math.max(1, Number(body.ayGunu) || 1));
      const haftaGunu = Math.min(6, Math.max(0, Number(body.haftaGunu) || 1)); // 0=Paz .. 6=Cmt, default 1=Pzt
      if (!metin) return gonder(res, 400, { error: "Not gerekli." });
      if (!/^\d{2}:\d{2}$/.test(saat)) return gonder(res, 400, { error: "Saat geçersiz." });
      if (!/^\d{4}-\d{2}-\d{2}$/.test(baslangic)) return gonder(res, 400, { error: "Başlangıç tarihi gerekli." });
      if (!["aylik", "haftalik", "gunluk"].includes(periyot)) {
        return gonder(res, 400, { error: "Periyot aylık, haftalık veya günlük olmalı." });
      }
      const bas = new Date(baslangic + "T00:00:00");
      if (!Number.isFinite(bas.getTime())) return gonder(res, 400, { error: "Başlangıç tarihi geçersiz." });
      if (yilBoyu || !/^\d{4}-\d{2}-\d{2}$/.test(bitis)) {
        bitis = bas.getFullYear() + "-12-31";
      }
      const son = new Date(bitis + "T00:00:00");
      if (!Number.isFinite(son.getTime()) || son < bas) {
        return gonder(res, 400, { error: "Bitiş tarihi geçersiz." });
      }
      const tarihler = [];
      const yazi = (d) => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
      const maxAdet = periyot === "gunluk" ? 366 : 120;
      if (periyot === "gunluk") {
        for (let d = new Date(bas); d <= son && tarihler.length < maxAdet; d.setDate(d.getDate() + 1)) {
          tarihler.push(yazi(d));
        }
      } else if (periyot === "haftalik") {
        let d = new Date(bas);
        while (d.getDay() !== haftaGunu) d.setDate(d.getDate() + 1);
        for (; d <= son && tarihler.length < maxAdet; d.setDate(d.getDate() + 7)) {
          tarihler.push(yazi(d));
        }
      } else {
        let yil = bas.getFullYear();
        let ay = bas.getMonth();
        for (; tarihler.length < maxAdet; ) {
          const sonGun = new Date(yil, ay + 1, 0).getDate();
          const gun = Math.min(ayGunu, sonGun);
          const d = new Date(yil, ay, gun);
          if (d >= bas && d <= son) tarihler.push(yazi(d));
          ay += 1;
          if (ay > 11) { ay = 0; yil += 1; }
          if (new Date(yil, ay, 1) > son) break;
        }
      }
      if (!tarihler.length) return gonder(res, 400, { error: "Seçilen aralıkta tarih oluşmadı." });
      const liste = hatirlatmalariOku();
      const grup = randomBytes(4).toString("hex");
      const eklenen = [];
      const uyarilar = [];
      for (const gun of tarihler) {
        const item = {
          id: randomBytes(6).toString("hex"),
          gun,
          saat,
          metin,
          gonderildi: false,
          olusturma: new Date().toISOString(),
          grup,
          periyot,
        };
        liste.push(item);
        eklenen.push(item);
      }
      hatirlatmalariYaz(liste);
      for (const item of eklenen) {
        try {
          await hatirlatmaGorevKur(item);
        } catch (error) {
          uyarilar.push(item.gun + ": " + (error.message || "gorev kurulamadi"));
        }
      }
      gonder(res, 200, {
        adet: eklenen.length,
        items: liste,
        eklenen,
        uyari: uyarilar.length ? ("Bazı Windows görevleri kurulamadı (" + uyarilar.length + ")") : "",
      });
      return;
    }

    if (req.method === "DELETE" && url.pathname === "/api/hatirlatma") {
      if (!oturum(req)) return gonder(res, 401, { error: "Giriş gerekli." });
      const id = String(url.searchParams.get("id") || "").trim();
      if (!id) return gonder(res, 400, { error: "Hatırlatma seçin." });
      const ham = hatirlatmalariOku();
      const hedef = ham.find((row) => row.id === id);
      const silinecek = new Set([id]);
      if (hedef?.onceBagliId) silinecek.add(hedef.onceBagliId);
      for (const row of ham) {
        if (row.onceAnaId === id) silinecek.add(row.id);
      }
      let googleSilindi = false;
      let uyari = "";
      const uzakVar = ham.some((row) => silinecek.has(row.id) && (row.googleEventId || row.googleTaskId));
      if (uzakVar && !googleDurum().bagli) {
        uyari = "Google bağlı değil. Telefonda durabilir.";
      } else {
        try {
          for (const row of ham) {
            if (!silinecek.has(row.id)) continue;
            if (await googleHatirlatmaUzaktaSil(row)) googleSilindi = true;
          }
        } catch (error) {
          return gonder(res, 400, { error: "Google’dan silinemedi. Kayıt duruyor. " + (error.message || "") });
        }
      }
      for (const sid of silinecek) await hatirlatmaGorevSil(sid);
      const liste = ham.filter((row) => !silinecek.has(row.id)).map((row) => {
        if (row.onceBagliId && silinecek.has(row.onceBagliId)) {
          const kopya = { ...row };
          delete kopya.onceBagliId;
          return kopya;
        }
        return row;
      });
      hatirlatmalariYaz(liste);
      gonder(res, 200, { items: liste, googleSilindi, uyari });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/google/durum") {
      if (!oturum(req)) return gonder(res, 401, { error: "Giriş gerekli." });
      gonder(res, 200, googleDurum());
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/google/ayar") {
      if (!oturum(req)) return gonder(res, 401, { error: "Giriş gerekli." });
      const body = await okuGovde(req);
      const ayar = googleAyarYaz({
        clientId: body.clientId,
        clientSecret: body.clientSecret,
        apiKey: body.apiKey,
        calendarId: body.calendarId,
        autoSync: body.autoSync,
        autoSyncDk: body.autoSyncDk,
      });
      gonder(res, 200, {
        ...googleDurum(),
        kaydedildi: Boolean((ayar.clientId && ayar.clientSecret) || ayar.apiKey),
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/google/api-key") {
      if (!oturum(req)) return gonder(res, 401, { error: "Giriş gerekli." });
      const body = await okuGovde(req);
      const apiKey = String(body.apiKey || "").trim();
      if (!apiKey) return gonder(res, 400, { error: "API anahtarı gerekli." });
      googleAyarYaz({ apiKey });
      try {
        const dogrulama = await googleApiKeyDogrula();
        gonder(res, 200, { ...googleDurum(), kaydedildi: true, ...dogrulama });
      } catch (error) {
        gonder(res, 200, {
          ...googleDurum(),
          kaydedildi: true,
          ok: false,
          mesaj: error.message || "API anahtarı kaydedildi ancak doğrulanamadı.",
        });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/google/ayar-json") {
      if (!oturum(req)) return gonder(res, 401, { error: "Giriş gerekli." });
      const body = await okuGovde(req);
      let ham = body.json;
      const yol = String(body.yol || "").trim();
      if (!ham && yol) {
        if (!existsSync(yol)) return gonder(res, 400, { error: "JSON dosyası bulunamadı." });
        ham = readFileSync(yol, "utf8");
      }
      if (!ham && body.indirilen) {
        const adaylar = googleIndirilenSecretYollari();
        if (!adaylar.length) return gonder(res, 400, { error: "Downloads klasöründe client_secret JSON bulunamadı." });
        ham = readFileSync(adaylar[0], "utf8");
      }
      if (!ham) return gonder(res, 400, { error: "JSON içeriği veya dosya yolu gerekli." });
      let parsed;
      try {
        parsed = googleClientSecretParse(ham);
      } catch (error) {
        return gonder(res, 400, { error: error.message || "JSON okunamadı." });
      }
      googleAyarYaz({
        clientId: parsed.clientId || undefined,
        clientSecret: parsed.clientSecret || undefined,
        apiKey: parsed.apiKey || undefined,
        calendarId: body.calendarId,
      });
      // Yerel kopya (senkron için)
      try {
        writeFileSync(join(googleKok(), "client_secret.json"), typeof ham === "string" ? ham : JSON.stringify(ham, null, 2), "utf8");
      } catch { /* kopyalanamadı */ }
      gonder(res, 200, {
        ...googleDurum(),
        kaydedildi: true,
        tip: parsed.tip,
        clientId: parsed.clientId,
        apiKey: parsed.apiKey ? true : false,
        uyari: parsed.tip === "apiKey"
          ? "API anahtarı yüklendi. Takvim yazmak için Client ID/Secret + Google ile bağla da gerekir."
          : (parsed.tip === "web"
            ? "Web istemcisi: Google Console’da yönlendirme URI’sini eklediğinizden emin olun."
            : ""),
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/google/baglan") {
      if (!oturum(req)) return gonder(res, 401, { error: "Giriş gerekli." });
      const ayar = googleAyarOku();
      if (!ayar.clientId || !ayar.clientSecret) {
        return gonder(res, 400, { error: "Önce Google Client ID ve Client Secret kaydedin." });
      }
      // Eski dar kapsamlı token'ı temizle; yeniden izin alınacak
      googleTokenSil();
      googleOAuthState = randomBytes(16).toString("hex");
      const params = new URLSearchParams({
        client_id: ayar.clientId,
        redirect_uri: googleRedirectUri(),
        response_type: "code",
        scope: [
          "https://www.googleapis.com/auth/calendar",
          "https://www.googleapis.com/auth/calendar.events",
          "https://www.googleapis.com/auth/tasks",
          "https://www.googleapis.com/auth/userinfo.email",
        ].join(" "),
        access_type: "offline",
        prompt: "consent",
        include_granted_scopes: "true",
        state: googleOAuthState,
      });
      const authUrl = "https://accounts.google.com/o/oauth2/v2/auth?" + params.toString();
      try {
        // cmd start URL'deki & karakterlerini keser → response_type kaybolur; rundll32 ile aç
        execFile("rundll32", ["url.dll,FileProtocolHandler", authUrl], { windowsHide: true }, () => {});
      } catch {
        const guvenli = authUrl.replace(/'/g, "''");
        execFile("powershell.exe", [
          "-NoProfile", "-WindowStyle", "Hidden", "-Command",
          "Start-Process '" + guvenli + "'",
        ], { windowsHide: true }, () => {});
      }
      gonder(res, 200, { ok: true, authUrl });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/google/callback") {
      const kod = String(url.searchParams.get("code") || "").trim();
      const state = String(url.searchParams.get("state") || "").trim();
      const hata = String(url.searchParams.get("error") || "").trim();
      const htmlSonuc = (basarili, mesaj) => `<!doctype html><html lang="tr"><meta charset="utf-8"><title>Google</title>
<body style="font-family:Segoe UI,sans-serif;background:#e7eef3;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0">
<div style="background:#fff;border:1px solid #b7c8d2;border-radius:14px;padding:24px 28px;max-width:420px;box-shadow:0 12px 28px rgba(20,40,55,.18)">
<h2 style="margin:0 0 8px;color:${basarili ? "#0e5962" : "#b42318"}">${basarili ? "Google bağlandı" : "Bağlantı başarısız"}</h2>
<p style="margin:0;color:#3a4a56;line-height:1.4">${mesaj}</p>
<p style="margin:14px 0 0;color:#6a7a86;font-size:13px">Bu pencereyi kapatıp Vega Raporlama’ya dönebilirsiniz.</p>
</div></body></html>`;
      if (hata) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(htmlSonuc(false, "Google izni verilmedi: " + hata));
        return;
      }
      if (!kod || !state || state !== googleOAuthState) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(htmlSonuc(false, "Geçersiz veya süresi dolmuş bağlantı isteği."));
        return;
      }
      googleOAuthState = "";
      try {
        const ayar = googleAyarOku();
        const govde = new URLSearchParams({
          code: kod,
          client_id: ayar.clientId,
          client_secret: ayar.clientSecret,
          redirect_uri: googleRedirectUri(),
          grant_type: "authorization_code",
        });
        const yanit = await fetch("https://oauth2.googleapis.com/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: govde.toString(),
        });
        const data = await yanit.json();
        if (!yanit.ok) throw new Error(data.error_description || data.error || "Token alınamadı.");
        const email = await googleEmailGetir(data.access_token);
        googleBaglantiUyari = "";
        googleTokenYaz({
          access_token: data.access_token,
          refresh_token: data.refresh_token,
          expiry: Date.now() + (Number(data.expires_in) || 3600) * 1000,
          email,
          olusturma: new Date().toISOString(),
        });
        setTimeout(() => {
          googleArkaPlanGorevSenkronize().catch(() => {});
          googleOtomatikSenkronCalistir("baglanti").catch(() => {});
        }, 1500);
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(htmlSonuc(true, (email ? email + " hesabı bağlandı. " : "") + "Otomatik senkron açık; hatırlatmalar belirli aralıklarla Google Takvim’e aktarılır."));
      } catch (error) {
        res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
        res.end(htmlSonuc(false, error.message || "Bağlantı hatası"));
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/google/senkron") {
      const kim = oturum(req);
      if (!kim) return gonder(res, 401, { error: "Giriş gerekli." });
      if (!googleDurum().bagli) return gonder(res, 400, { error: "Önce Google hesabını bağlayın." });
      let body = {};
      try { body = await okuGovde(req); } catch { body = {}; }
      const baglam = {
        firma: tamSayi(body.firma) || tamSayi(kim.firma),
        donem: tamSayi(body.donem) || tamSayi(kim.donem),
      };
      const sonuc = await googleOtomatikSenkronCalistir("manuel", baglam);
      if (!sonuc) {
        const son = googleSonSenkronOku();
        if (son?.hata) return gonder(res, 400, { error: son.hata, durum: googleDurum() });
        return gonder(res, 400, { error: "Google senkronu şu an meşgul. Birkaç saniye sonra tekrar deneyin.", durum: googleDurum() });
      }
      gonder(res, 200, { ok: true, ...sonuc, durum: googleDurum() });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/google/kopar") {
      if (!oturum(req)) return gonder(res, 401, { error: "Giriş gerekli." });
      googleTokenSil();
      googleArkaPlanGorevSil().catch(() => {});
      gonder(res, 200, { ok: true, ...googleDurum() });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/kapat") {
      gonder(res, 200, { ok: true });
      setTimeout(uygulamayiKapat, 200);
      return;
    }

    gonder(res, 404, { error: "Sayfa yok." });
  } catch (error) {
    gonder(res, 500, { error: error.message || "Sunucu hatası" });
  }
});

async function googleArkaPlanSenkronCalistirVeCik() {
  try {
    konsoluGizle();
    if (!googleDurum().bagli) {
      process.exitCode = 0;
      return;
    }
    const ayar = googleAyarOku();
    if (ayar.autoSync === false) {
      process.exitCode = 0;
      return;
    }
    await googleOtomatikSenkronCalistir("arka-plan", googleBaglamOku());
    process.exitCode = 0;
  } catch (error) {
    try {
      googleSonSenkronYaz({
        zaman: new Date().toISOString(),
        kaynak: "arka-plan",
        hata: error.message || "Arka plan senkron hatası",
      });
    } catch { /* ok */ }
    process.exitCode = 1;
  } finally {
    setTimeout(() => process.exit(process.exitCode || 0), 200);
  }
}

if (process.argv.includes("--google-senkron-arka")) {
  googleArkaPlanSenkronCalistirVeCik();
} else {
server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    // Port doluysa mevcut sunucuya bağlanan pencereyi aç; Edge'in kalkması için kısa bekle.
    uygulamaPenceresi(`http://127.0.0.1:${PORT}`, false);
    setTimeout(() => process.exit(0), 2000);
    return;
  }
  if (!paketMi()) console.error(error.message || "Sunucu açılmadı");
  process.exit(1);
});

server.requestTimeout = 30 * 60 * 1000;
server.headersTimeout = 30 * 60 * 1000;
server.listen(PORT, "0.0.0.0", () => {
  const adres = `http://127.0.0.1:${PORT}`;
  if (konsolAcikMi()) {
    console.log(`Vega Raporlama ${adres}`);
    for (const ag of Object.values(networkInterfaces()).flat()) {
      if (!ag || ag.internal) continue;
      if (ag.family !== "IPv4" && ag.family !== 4) continue;
      console.log(`Ağdan: http://${ag.address}:${PORT}`);
    }
    console.log(`Veritabanı: ${link.server} / ${link.database}`);
    if (!existsSync(UDL)) console.warn(`Bağlantı dosyası bulunamadı: ${UDL}`);
    console.log(SQLCMD ? "Sorgu aracı: sqlcmd" : "Sorgu aracı: Windows SQL istemcisi");
  }
  girisOnbilgiGetir(0).catch(() => {});
  hatirlatmaGorevleriniSenkronize().catch(() => {});
  masaustuUygulamaIlkAcilisGuncelle();
  googleOtomatikSenkronKur();
  googleArkaPlanGorevSenkronize().catch(() => {});
  setTimeout(() => {
    googleOtomatikSenkronCalistir("baslangic").catch(() => {});
    teklifHatirlatmaOtomatik(true).catch(() => {});
  }, 20000);
  const teklifZaman = setInterval(() => {
    teklifHatirlatmaOtomatik().catch(() => {});
  }, 5 * 60 * 1000);
  if (teklifZaman.unref) teklifZaman.unref();
  if (existsSync(join(whatsappKlasor(), "creds.json"))) {
    whatsappBagla().catch((error) => {
      wa.durum = "hata";
      wa.hata = error.message || "Kayıtlı telefon bağlantısı açılamadı.";
    });
  }
  konsoluGizle();
  setTimeout(konsoluGizle, 300);
  uygulamaPenceresi(adres);
  guncellemeOtomatikKur();
});
}
