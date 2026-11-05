const { execFile, spawn } = require("node:child_process");
const { randomBytes } = require("node:crypto");
const { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, unlinkSync, rmSync } = require("node:fs");
const { createServer } = require("node:http");
const { networkInterfaces, tmpdir } = require("node:os");
const { basename, dirname, join } = require("node:path");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);
const PORT = Number(process.env.PORT || 3850);

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
    "    if ($sarmal -eq 'satir') {",
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

function queryLines(sql) {
  const ayikla = (text) => text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("(") && line.includes("|"));
  const ps = () => psCalistir(sql, "lines").then((stdout) => ayikla(sorguMetni(stdout)), sorguHatasi);
  if (!SQLCMD) return ps();
  return sqlCalistir(sql, ["-h", "-1", "-s", "|", "-y", "400", "-Y", "400"]).then(({ stdout }) => {
    return ayikla(decodeSql(stdout));
  }).catch(() => ps());
}

async function nesneVar(ad) {
  const adlar = (Array.isArray(ad) ? ad : [ad]).map((item) => String(item).replace(/[^\w]/g, "")).filter(Boolean);
  if (!adlar.length) return "";
  const liste = adlar.map((item) => `N'${item}'`).join(", ");
  const lines = await queryLines(`
SET NOCOUNT ON;
SELECT N'v', TABLE_NAME
FROM INFORMATION_SCHEMA.TABLES
WHERE TABLE_NAME IN (${liste});
`);
  const bulunan = new Set(lines.map((line) => (line.split("|")[1] || "").trim().toUpperCase()));
  return adlar.find((item) => bulunan.has(item.toUpperCase())) || "";
}

async function kolonKumesi(tablo) {
  const ad = String(tablo).replace(/[^\w]/g, "");
  if (!ad) return new Set();
  const lines = await queryLines(`
SET NOCOUNT ON;
SELECT N'v', COLUMN_NAME
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_NAME = N'${ad}';
`);
  return new Set(lines.map((line) => (line.split("|")[1] || "").trim().toUpperCase()));
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

function donemTablo(firma, donem, ad) {
  return `F${pad(firma)}D${pad(donem)}${ad}`;
}

const oturumlar = new Map();

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

const wa = {
  sock: null,
  durum: "kapali",
  qr: "",
  ad: "",
  hata: "",
  kapanis: false,
  baslatma: null,
};

function whatsappDurum() {
  return {
    hazir: wa.durum === "bagli",
    durum: wa.durum,
    qr: wa.durum === "qr" ? wa.qr : "",
    ad: wa.ad,
    hata: wa.hata,
  };
}

function telefonNorm(value) {
  let rakam = String(value || "").replace(/\D/g, "");
  if (rakam.startsWith("00")) rakam = rakam.slice(2);
  if (rakam.startsWith("0")) rakam = "90" + rakam.slice(1);
  if (rakam.length === 10 && rakam.startsWith("5")) rakam = "90" + rakam;
  return rakam;
}

async function whatsappAc() {
  const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    Browsers,
  } = await import("@whiskeysockets/baileys");
  const pino = (await import("pino")).default;
  const qrcode = await import("qrcode");
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
      wa.ad = String(kullanici.name || kullanici.id || "").split(":")[0].split("@")[0];
    }
    if (update.connection === "close") {
      const kod = update.lastDisconnect?.error?.output?.statusCode;
      if (wa.sock === sock) wa.sock = null;
      wa.qr = "";
      const cikis = wa.kapanis || kod === DisconnectReason.loggedOut || kod === DisconnectReason.forbidden;
      if (cikis) {
        wa.durum = "kapali";
        wa.ad = "";
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
  wa.hata = "";
  wa.durum = "kapali";
  try { await sock?.logout(); } catch { /* oturum zaten kapalı */ }
  try { rmSync(whatsappKlasor(), { recursive: true, force: true }); } catch { /* oturum silinemedi */ }
  return whatsappDurum();
}

function edgeBul() {
  const pf = process.env.ProgramFiles || "C:\\Program Files";
  const pf86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const local = process.env.LOCALAPPDATA || "";
  return ilkVarolan([
    join(pf, "Microsoft", "Edge", "Application", "msedge.exe"),
    join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"),
    join(local, "Microsoft", "Edge", "Application", "msedge.exe"),
    join(pf, "Google", "Chrome", "Application", "chrome.exe"),
    join(pf86, "Google", "Chrome", "Application", "chrome.exe"),
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

function konsoluGizle() {
  if (!paketMi()) return;
  execFile("powershell.exe", [
    "-NoProfile",
    "-WindowStyle", "Hidden",
    "-Command",
    `Add-Type -Namespace Vega -Name Pencere -MemberDefinition '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);'; $p = Get-Process -Id ${process.pid} -ErrorAction SilentlyContinue; if ($p -and $p.MainWindowHandle -ne [IntPtr]::Zero) { [Vega.Pencere]::ShowWindow($p.MainWindowHandle, 0) | Out-Null }`,
  ], { windowsHide: true });
}

function pencereOlcuDosya() {
  return join(process.env.LOCALAPPDATA || tmpdir(), "Vega Raporlama", "pencere-olcu.json");
}

function pencereArguman(adres, profil) {
  const arguman = [
    "--app=" + adres,
    "--user-data-dir=" + profil,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-sync",
  ];
  try {
    const olcu = JSON.parse(readFileSync(pencereOlcuDosya(), "utf8"));
    const genislik = Math.round(Number(olcu.genislik));
    const yukseklik = Math.round(Number(olcu.yukseklik));
    const left = Math.round(Number(olcu.left));
    const top = Math.round(Number(olcu.top));
    if (olcu.tam === true) arguman.push("--start-maximized");
    else if (genislik >= 480 && genislik <= 8000 && yukseklik >= 320 && yukseklik <= 8000) {
      arguman.push("--window-size=" + genislik + "," + yukseklik);
      if (left >= -4000 && left <= 8000 && top >= -4000 && top <= 8000) {
        arguman.push("--window-position=" + left + "," + top);
      }
    }
  } catch { /* ilk açılış */ }
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
  const child = spawn(tarayici, pencereArguman(adres, profil), { windowsHide: true, stdio: "ignore" });
  child.on("error", () => {
    execFile("cmd.exe", ["/c", "start", "", adres], { windowsHide: true });
  });
  if (!izle) return;
  const bas = Date.now();
  const denetle = () => {
    execFile("powershell.exe", [
      "-NoProfile",
      "-WindowStyle", "Hidden",
      "-Command",
      "$bul = Get-CimInstance Win32_Process -Filter \"Name='$env:VEGA_PENCERE_AD'\" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($env:VEGA_PENCERE_PROFIL) }; if ($bul) { 'acik' } else { 'kapali' }",
    ], {
      windowsHide: true,
      timeout: 15000,
      env: { ...process.env, VEGA_PENCERE_AD: basename(tarayici), VEGA_PENCERE_PROFIL: profil },
    }, (error, stdout) => {
      if (error) return;
      if (String(stdout).includes("kapali") && Date.now() - bas > 8000) process.exit(0);
    });
  };
  const zaman = setInterval(denetle, 3000);
  zaman.unref();
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

async function whatsappPdf(telefon, pdf, dosyaAdi, ozet) {
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

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  try {
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(sayfaOku());
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

    if (req.method === "GET" && (url.pathname === "/favicon.ico" || url.pathname === "/expert-bilisim.ico")) {
      const yol = ikonYolu();
      if (!yol) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { "Content-Type": "image/x-icon", "Cache-Control": "public, max-age=86400" });
      res.end(readFileSync(yol));
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/baglanti") {
      gonder(res, 200, { server: link.server, database: link.database });
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
      const rows = await query(`
SET NOCOUNT ON;
SELECT IND AS no, KOD AS kod, ISNULL(KISAAD, N'') AS kisaAd, ISNULL(AD1, N'') AS ad, AKTIFDONEM AS aktifDonem
FROM TBLFIRMA
ORDER BY IND
FOR JSON PATH;
`);
      gonder(res, 200, { items: rows });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/donemler") {
      const firma = tamSayi(url.searchParams.get("firma"));
      if (!firma) return gonder(res, 400, { error: "Firma seçin." });
      const rows = await query(`
SET NOCOUNT ON;
SELECT IND AS no, DONEM AS yil
FROM TBLDONEM
WHERE FIND = ${firma}
ORDER BY DONEM
FOR JSON PATH;
`);
      gonder(res, 200, { items: rows });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/subeler") {
      const firma = tamSayi(url.searchParams.get("firma"));
      if (!firma) return gonder(res, 400, { error: "Firma seçin." });
      const rows = await query(`
SET NOCOUNT ON;
SELECT IND AS no, ISNULL(NULLIF(SUBEAD, N''), N'MERKEZ') AS ad
FROM ${firmaTablo(firma, "TBLSUBELER")}
ORDER BY IND
FOR JSON PATH;
`);
      gonder(res, 200, { items: rows.length ? rows : [{ no: 1, ad: "MERKEZ" }] });
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
        const kosullar = [
          "ISNULL(DELETED, 0) = 0",
          `NOT EXISTS (SELECT 1 FROM ${hareket} h WHERE h.FIRMANO = ${ozet}.IND)`,
        ];
        const bulunan = arama("FIRMAKODU", "FIRMAADI");
        if (bulunan) kosullar.push(bulunan);
        kosullar.push(...ozelKodlar((no, deger) => `RTRIM(KOD${no}) = N'${deger}'`));
        lines = await queryLines(`
SET NOCOUNT ON;
SELECT
  ${yazi("ISNULL(FIRMAKODU, N'')")},
  ${yazi("ISNULL(FIRMAADI, N'')")},
  ${yazi("ISNULL(PARABIRIMI, N'')")},
  ${yazi("CASE FIRMATIPI WHEN 1 THEN N'A' WHEN 2 THEN N'S' WHEN 3 THEN N'AS' ELSE RTRIM(CAST(ISNULL(FIRMATIPI, 0) AS nvarchar(10))) END")},
  N'Bakiyesizler',
  CAST(0 AS decimal(18, 2)),
  CAST(0 AS decimal(18, 2)),
  CAST(0 AS decimal(18, 2))
FROM ${ozet}
WHERE ${kosullar.join(" AND ")}
ORDER BY FIRMAKODU;
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
  ON c.FIRMAKODU COLLATE Latin1_General_CI_AI = v.FIRMAKODU COLLATE Latin1_General_CI_AI
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
        const [kod, ad, pb, tip, durum, borc, alacak, bakiye] = line.split("|").map((part) => part.trim());
        return {
          kod,
          ad,
          pb,
          tip,
          durum,
          borc: Number(borc),
          alacak: Number(alacak),
          bakiye: Number(bakiye),
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
WHERE c.FIRMAKODU COLLATE Latin1_General_CI_AI = N'${kod}'
  ${pbSql}
ORDER BY h.TARIH, h.IND;
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
WHERE c.FIRMAKODU COLLATE Latin1_General_CI_AI = N'${kod}'
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
WHERE c.FIRMAKODU COLLATE Latin1_General_CI_AI = N'${kod}'
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
WHERE c.FIRMAKODU COLLATE Latin1_General_CI_AI = N'${kod}'
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
WHERE FIRMAKODU COLLATE Latin1_General_CI_AI = N'${kod}';
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
WHERE c.FIRMAKODU COLLATE Latin1_General_CI_AI = N'${kod}'
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
        const telSatir = await queryLines(`
SET NOCOUNT ON;
SELECT
  REPLACE(REPLACE(REPLACE(RTRIM(ISNULL(YGSM, N'')), N'|', N'/'), CHAR(13), N' '), CHAR(10), N' '),
  REPLACE(REPLACE(REPLACE(RTRIM(ISNULL(TELEFON1, N'')), N'|', N'/'), CHAR(13), N' '), CHAR(10), N' '),
  REPLACE(REPLACE(REPLACE(RTRIM(ISNULL(TELEFON2, N'')), N'|', N'/'), CHAR(13), N' '), CHAR(10), N' '),
  REPLACE(REPLACE(REPLACE(RTRIM(ISNULL(TELEFON3, N'')), N'|', N'/'), CHAR(13), N' '), CHAR(10), N' '),
  CASE WHEN SMSGONDER = 1 THEN 1 ELSE 0 END
FROM ${cari}
WHERE FIRMAKODU COLLATE Latin1_General_CI_AI = N'${kod}';
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
      if (izahat === 13 && belgeNo) {
        const baslikTablo = donemTablo(firma, donem, "TBLCARGIRBASLIK");
        const detayTablo = donemTablo(firma, donem, "TBLCARGIRHAREKET");
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
            tur: "cargir",
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
            ad: firmaAd,
            aciklama: "",
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
        temizSatir.push({
          izahat,
          portno: portNo(satir?.portfoy),
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
VALUES (${satir.izahat}, ${satir.portno}, @ind, N'${satir.aciklama}', ${satir.vade}, ${satir.tutar}, N'${satir.pb}', ${satir.kur}, @firma, 0);`).join("");
      const sql = `
SET NOCOUNT ON;
SET XACT_ABORT ON;
BEGIN TRY
  BEGIN TRAN;
  DECLARE @firma int, @ind int, @sira int, @belge nvarchar(16);
  SELECT TOP 1 @firma = IND
  FROM ${cari}
  WHERE FIRMAKODU COLLATE Latin1_General_CI_AI = N'${kod}';
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
    USERNO, OZELKOD1, OZELKOD2, OZELKOD3, OZELKOD4, OZELKOD5, OZELKOD6, ACIKLAMA, CREDATE
  ) VALUES (
    @firma, @belge, ${tarih}, 0, ${sqlOndalik(body.vadeYuzde || 0)}, ${toplam}, N'${pb}', ${kur}, ${cikis ? 11 : 13}, 0, ${cikis ? 0 : 1},
    ${tamSayi(kim.no, 999999) || 0}, N'${metin(body.sube || "MERKEZ", 15)}', N'${metin(body.kasa || "MERKEZ", 15)}',
    N'${metin(body.ok1, 30)}', N'${metin(body.ok2, 30)}', N'${metin(body.ok3, 200)}', N'${metin(body.ok4, 30)}',
    N'${metin(body.aciklama, 400)}', GETDATE()
  );
  SET @ind = SCOPE_IDENTITY();
  ${satirSql}
  INSERT INTO ${hareket} (IZAHAT, LN, EVRAKNO, BORC, ALACAK, PARABIRIMI, KUR, TARIH, FIRMANO)
  VALUES (${cikis ? 11 : 13}, @ind, @belge, ${cikis ? toplam : "0"}, ${cikis ? "0" : toplam}, N'${pb}', ${kur}, ${tarih}, @firma);
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

    gonder(res, 404, { error: "Sayfa yok." });
  } catch (error) {
    gonder(res, 500, { error: error.message || "Sunucu hatası" });
  }
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    uygulamaPenceresi(`http://127.0.0.1:${PORT}`, false);
    process.exit(0);
  }
  console.error(error.message || "Sunucu açılmadı");
  process.exit(1);
});

server.listen(PORT, "0.0.0.0", () => {
  const adres = `http://127.0.0.1:${PORT}`;
  console.log(`Vega Raporlama ${adres}`);
  for (const ag of Object.values(networkInterfaces()).flat()) {
    if (!ag || ag.internal) continue;
    if (ag.family !== "IPv4" && ag.family !== 4) continue;
    console.log(`Ağdan: http://${ag.address}:${PORT}`);
  }
  console.log(`Veritabanı: ${link.server} / ${link.database}`);
  if (!existsSync(UDL)) console.warn(`Bağlantı dosyası bulunamadı: ${UDL}`);
  console.log(SQLCMD ? "Sorgu aracı: sqlcmd" : "Sorgu aracı: Windows SQL istemcisi");
  if (existsSync(join(whatsappKlasor(), "creds.json"))) {
    whatsappBagla().catch((error) => {
      wa.durum = "hata";
      wa.hata = error.message || "Kayıtlı telefon bağlantısı açılamadı.";
    });
  }
  konsoluGizle();
  uygulamaPenceresi(adres);
});
