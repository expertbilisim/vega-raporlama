const { execFile } = require("node:child_process");
const { randomBytes } = require("node:crypto");
const { existsSync, readFileSync, writeFileSync, unlinkSync } = require("node:fs");
const { createServer } = require("node:http");
const { tmpdir } = require("node:os");
const { dirname, join } = require("node:path");
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

function sqlHata(error) {
  const detail = decodeSql(error.stderr || error.stdout || error.message)
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
  if (!SQLCMD) {
    return psCalistir(sql, "json").then((stdout) => parseJsonMetin(sorguMetni(stdout)), sorguHatasi);
  }
  return sqlCalistir(sql, ["-r", "1", "-y", "0"]).then(({ stdout }) => parseJson(stdout), (error) => {
    throw sqlHata(error);
  });
}

function queryLines(sql) {
  const ayikla = (text) => text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("(") && line.includes("|"));
  if (!SQLCMD) {
    return psCalistir(sql, "lines").then((stdout) => ayikla(sorguMetni(stdout)), sorguHatasi);
  }
  return sqlCalistir(sql, ["-h", "-1", "-s", "|", "-y", "400", "-Y", "400"]).then(({ stdout }) => {
    return ayikla(decodeSql(stdout));
  }, (error) => {
    throw sqlHata(error);
  });
}

function tamSayi(value, max = 9999) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > max) return null;
  return n;
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

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  try {
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(sayfaOku());
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
      const label = firmaTablo(firma, "TBLSTOKKARTKODLABEL");
      const tan = firmaTablo(firma, "TBLSTOKKODTAN");
      const temiz = (ifade) => `REPLACE(REPLACE(REPLACE(RTRIM(ISNULL(${ifade}, N'')), N'|', N'/'), CHAR(13), N' '), CHAR(10), N' ')`;
      const lines = await queryLines(`
SET NOCOUNT ON;
SELECT CAST(CATEGORY AS varchar(4)), ${temiz("CAPTION")}, N''
FROM ${label}
WHERE CATEGORY BETWEEN 1 AND 10
UNION ALL
SELECT CAST(CATEGORY AS varchar(4)), N'', ${temiz("KOD")}
FROM ${tan}
WHERE CATEGORY BETWEEN 1 AND 10 AND RTRIM(ISNULL(KOD, N'')) <> N'';
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
      const label = firmaTablo(firma, "TBLCARIKARTKODLABEL");
      const tan = firmaTablo(firma, "TBLCARIKODTAN");
      const temiz = (ifade) => `REPLACE(REPLACE(REPLACE(RTRIM(ISNULL(${ifade}, N'')), N'|', N'/'), CHAR(13), N' '), CHAR(10), N' ')`;
      const lines = await queryLines(`
SET NOCOUNT ON;
SELECT CAST(CATEGORY - 100 AS varchar(4)), ${temiz("CAPTION")}, N''
FROM ${label}
WHERE CATEGORY BETWEEN 101 AND 107
UNION ALL
SELECT CAST(CATEGORY AS varchar(4)), N'', ${temiz("KOD")}
FROM ${tan}
WHERE CATEGORY BETWEEN 1 AND 7 AND RTRIM(ISNULL(KOD, N'')) <> N'';
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
      const ozet = donemTablo(firma, donem, "VARESCARIHAREKETOZET");
      const kosullar = [];
      if (like) kosullar.push(`(FIRMAKODU COLLATE Latin1_General_CI_AI LIKE N'${like}' OR FIRMAADI COLLATE Latin1_General_CI_AI LIKE N'${like}')`);
      for (let no = 1; no <= 7; no += 1) {
        const deger = metin(url.searchParams.get("ok" + no), 80).trim();
        if (deger) kosullar.push(`CARIKOD${no} = N'${deger}'`);
      }
      const filtre = kosullar.length ? `WHERE ${kosullar.join(" AND ")}` : "";
      const lines = await queryLines(`
SET NOCOUNT ON;
SELECT
  REPLACE(REPLACE(REPLACE(ISNULL(FIRMAKODU, N''), N'|', N'/'), CHAR(13), N' '), CHAR(10), N' '),
  REPLACE(REPLACE(REPLACE(ISNULL(FIRMAADI, N''), N'|', N'/'), CHAR(13), N' '), CHAR(10), N' '),
  REPLACE(REPLACE(REPLACE(ISNULL(PARABIRIMI, N''), N'|', N'/'), CHAR(13), N' '), CHAR(10), N' '),
  REPLACE(REPLACE(REPLACE(RTRIM(ISNULL(FIRMATIPI, N'')), N'|', N'/'), CHAR(13), N' '), CHAR(10), N' '),
  REPLACE(REPLACE(REPLACE(ISNULL(BAKIYEDURUMU, N''), N'|', N'/'), CHAR(13), N' '), CHAR(10), N' '),
  CAST(SUM(ISNULL(TLBORC, 0)) AS decimal(18, 2)),
  CAST(SUM(ISNULL(TLALACAK, 0)) AS decimal(18, 2)),
  CAST(SUM(ISNULL(TLBAKIYE, 0)) AS decimal(18, 2))
FROM ${ozet}
${filtre}
GROUP BY FIRMAKODU, FIRMAADI, PARABIRIMI, FIRMATIPI, BAKIYEDURUMU
ORDER BY FIRMAKODU, PARABIRIMI;
`);
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
      const pbSql = pb
        ? `AND RTRIM(ISNULL(h.PARABIRIMI, N'')) = N'${pb}'`
        : "";
      const aciklama = `LTRIM(RTRIM(REPLACE(REPLACE(REPLACE(
        CASE
          WHEN CHARINDEX(CHAR(13), ISNULL(CAST(h.ALTNOT AS nvarchar(400)), N'')) > 1 THEN LEFT(CAST(h.ALTNOT AS nvarchar(400)), CHARINDEX(CHAR(13), CAST(h.ALTNOT AS nvarchar(400))) - 1)
          WHEN CHARINDEX(CHAR(10), ISNULL(CAST(h.ALTNOT AS nvarchar(400)), N'')) > 1 THEN LEFT(CAST(h.ALTNOT AS nvarchar(400)), CHARINDEX(CHAR(10), CAST(h.ALTNOT AS nvarchar(400))) - 1)
          ELSE ISNULL(CAST(h.ALTNOT AS nvarchar(400)), N'')
        END, N'|', N'/'), CHAR(13), N' '), CHAR(10), N' ')))`;
      const lines = await queryLines(`
SET NOCOUNT ON;
SELECT
  h.IZAHAT,
  CONVERT(varchar(10), h.TARIH, 104),
  REPLACE(REPLACE(REPLACE(RTRIM(ISNULL(h.EVRAKNO, N'')), N'|', N'/'), CHAR(13), N' '), CHAR(10), N' '),
  ${aciklama},
  CAST(ISNULL(h.BORC, 0) AS decimal(18, 2)),
  CAST(ISNULL(h.ALACAK, 0) AS decimal(18, 2)),
  RTRIM(ISNULL(h.PARABIRIMI, N'')),
  CAST(ISNULL(h.LN, 0) AS int)
FROM ${hareket} h
JOIN ${cari} c ON c.IND = h.FIRMANO
WHERE c.FIRMAKODU COLLATE Latin1_General_CI_AI = N'${kod}'
  ${pbSql}
ORDER BY h.TARIH, h.IND;
`);
      const items = lines.map((line) => {
        const [izahat, tarih, evrakNo, aciklamaYazi, borc, alacak, paraBirimi, belgeNo] = line.split("|").map((part) => part.trim());
        return {
          izahat: Number(izahat),
          tarih,
          evrakNo,
          aciklama: aciklamaYazi,
          borc: Number(borc),
          alacak: Number(alacak),
          pb: paraBirimi,
          belgeNo: Number(belgeNo) || 0,
        };
      });
      gonder(res, 200, { kod, items });
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

    gonder(res, 404, { error: "Sayfa yok." });
  } catch (error) {
    gonder(res, 500, { error: error.message || "Sunucu hatası" });
  }
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`Port ${PORT} dolu. Açık Vega Raporlama penceresini kapatıp yeniden deneyin.`);
  } else {
    console.error(error.message || "Sunucu açılmadı");
  }
  process.exit(1);
});

server.listen(PORT, "127.0.0.1", () => {
  const adres = `http://127.0.0.1:${PORT}`;
  console.log(`Vega Raporlama ${adres}`);
  console.log(`Veritabanı: ${link.server} / ${link.database}`);
  if (!existsSync(UDL)) console.warn(`Bağlantı dosyası bulunamadı: ${UDL}`);
  console.log(SQLCMD ? "Sorgu aracı: sqlcmd" : "Sorgu aracı: Windows SQL istemcisi");
  console.log("Kapatmak için bu pencereyi kapatın.");
  let paketli = false;
  try { paketli = require("node:sea").isSea(); } catch { paketli = false; }
  if (paketli) execFile("cmd.exe", ["/c", "start", "", adres], { windowsHide: true });
});
