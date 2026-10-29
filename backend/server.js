"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { AsyncLocalStorage } = require("node:async_hooks");

const LOCAL_ENV_FILE = path.join(__dirname, ".env");
if (fs.existsSync(LOCAL_ENV_FILE)) {
  for (const line of fs.readFileSync(LOCAL_ENV_FILE, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || Object.prototype.hasOwnProperty.call(process.env, match[1])) continue;
    const value = match[2].replace(/^(['"])(.*)\1$/, "$2");
    process.env[match[1]] = value;
  }
}

const PORT = Number(process.env.PORT || 5000);
// Listen on all interfaces so hosted deployments and other devices can reach
// the API. Set HOST=127.0.0.1 to restrict it to this machine.
const HOST = process.env.HOST || "0.0.0.0";
const DATA_FILE = process.env.CHIMERA_DATA_FILE
  ? path.resolve(process.env.CHIMERA_DATA_FILE)
  : path.join(__dirname, "data.json");
const PROGRAMMES_FILE = path.join(__dirname, "programmes.json");
const SUPABASE_URL = String(process.env.SUPABASE_URL || "").replace(/\/+$/, "");
// Prefer Supabase's current server-side secret key. Keep the legacy service_role
// variable as a fallback for existing local deployments.
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const SUPABASE_API_KEY = SUPABASE_SECRET_KEY || SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_STATE_TABLE = process.env.SUPABASE_STATE_TABLE || "lms_state";
let supabaseConfigured = Boolean(SUPABASE_URL && SUPABASE_API_KEY);
const requestContext = new AsyncLocalStorage();
const STATIC_ROOT = path.resolve(__dirname, "..");
const PROGRAMMES = JSON.parse(fs.readFileSync(PROGRAMMES_FILE, "utf8"));
const JWT_SECRET = process.env.JWT_SECRET || "chimera-lms-local-development-secret-change-me";
const TOKEN_TTL_SECONDS = 60 * 60 * 12;
const STATIC_DIRECTORIES = new Set(["Css", "Javascript", "assets"]);
const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".webp": "image/webp"
};

function initialData() {
  return {
    users: [
      { id: "staff-lecturer", name: "Dr. Sarah Chen", email: "s.chen@faculty.edu", role: "lecturer", avatar: "SC", status: "Active", demo: true },
      { id: "staff-admin", name: "Marcus Rivera", email: "m.rivera@admin.edu", role: "admin", avatar: "MR", status: "Active", demo: true }
    ],
    courses: PROGRAMMES,
    assignments: [],
    enrollments: [],
    attendance: [],
    submissions: [],
    materials: [],
    program_applications: [],
    audit_log: []
  };
}

function loadData() {
  const context = requestContext.getStore();
  if (context?.data) return context.data;
  try {
    const data = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    if (!Array.isArray(data.attendance)) data.attendance = [];
    for (const key of ["notifications", "audit_log", "courses", "assignments", "submissions", "enrollments", "materials", "program_applications", "messages", "announcements", "quiz_attempts"]) if (!Array.isArray(data[key])) data[key] = [];
    return data;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const data = initialData();
    saveData(data);
    return data;
  }
}

function saveData(data) {
  const context = requestContext.getStore();
  if (supabaseConfigured && context) {
    context.data = data;
    context.dirty = true;
    return;
  }
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  const tempFile = `${DATA_FILE}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(data, null, 2));
  fs.renameSync(tempFile, DATA_FILE);
}

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

function makeToken(user) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({ sub: user.id, iat: now, exp: now + TOKEN_TTL_SECONDS }));
  const signature = crypto.createHmac("sha256", JWT_SECRET).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
}

function verifyToken(token) {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const expected = crypto.createHmac("sha256", JWT_SECRET).update(`${parts[0]}.${parts[1]}`).digest();
  let actual;
  let payload;
  try {
    actual = Buffer.from(parts[2], "base64url");
    payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected) || payload.exp < Date.now() / 1000) return null;
  return { id: payload.sub };
}

function publicUser(user) {
  const { id, name, username, email, role, avatar, profileImage, moduleProgress, moduleNotes, status, lastLogin, selectedCourse } = user;
  return { id, name, ...(username ? { username } : {}), email, role, avatar, ...(profileImage ? { profileImage } : {}), ...(moduleProgress ? { moduleProgress } : {}), ...(moduleNotes ? { moduleNotes } : {}), status, lastLogin, ...(selectedCourse ? { selectedCourse } : {}) };
}

function profileUser(user) {
  return {
    ...publicUser(user),
    identityNumber: user.identityNumber || "",
    passportNumber: user.passportNumber || "",
    dateOfBirth: user.dateOfBirth || "",
    gender: user.gender || "",
    phone: user.phone || "",
    lastSchool: user.lastSchool || ""
  };
}

async function send(response, status, payload) {
  const context = requestContext.getStore();
  if (supabaseConfigured && context?.dirty) {
    try {
      await persistSupabaseUsers(context.data.users || [], context.originalUsers || []);
      await persistSupabaseState(context.data, context.revision);
      context.revision += 1;
      context.dirty = false;
    } catch (error) {
      console.error("Supabase state write failed:", error.message);
      status = error.status || 503;
      payload = { error: error.status === 409 ? error.message : "Could not save LMS data to Supabase" };
    }
  }
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function supabaseHeaders(prefer) {
  return {
    apikey: SUPABASE_API_KEY,
    // New sb_secret keys are API keys, not JWTs; Supabase maps them to the
    // service_role database role from the apikey header alone. Legacy JWT keys
    // still need Authorization for the role to be applied to the request.
    ...(!SUPABASE_SECRET_KEY && SUPABASE_SERVICE_ROLE_KEY
      ? { Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` }
      : {}),
    "Content-Type": "application/json",
    ...(prefer ? { Prefer: prefer } : {})
  };
}

async function supabaseRequest(url, options = {}) {
  let response;
  try {
    response = await fetch(url, { ...options, headers: { ...supabaseHeaders(options.prefer), ...(options.headers || {}) } });
  } catch (error) {
    throw new Error(`Unable to reach Supabase: ${error.message}`);
  }
  const body = await response.text();
  let result = null;
  try { result = body ? JSON.parse(body) : null; } catch { result = body; }
  if (!response.ok) {
    const error = new Error(result?.message || result?.hint || `Supabase returned HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return result;
}

function supabaseStateUrl(query = "") {
  return `${SUPABASE_URL}/rest/v1/${encodeURIComponent(SUPABASE_STATE_TABLE)}${query}`;
}

function supabaseUsersUrl(query = "") {
  return `${SUPABASE_URL}/rest/v1/users${query}`;
}

const USER_COLUMN_FIELDS = new Set([
  "id", "name", "username", "email", "role", "status", "avatar", "profileImage",
  "identityNumber", "passportNumber", "dateOfBirth", "gender", "phone", "lastSchool",
  "passwordSalt", "passwordHash", "recoveryQuestion", "recoveryAnswerHash", "lastLogin",
  "legacyIdentityNumber", "legacyPassportNumber"
]);

function toSupabaseUser(user) {
  const attributes = Object.fromEntries(Object.entries(user).filter(([key]) => !USER_COLUMN_FIELDS.has(key)));
  if (user.legacyIdentityNumber) attributes.__legacyIdentityNumber = user.legacyIdentityNumber;
  if (user.legacyPassportNumber) attributes.__legacyPassportNumber = user.legacyPassportNumber;
  return {
    id: user.id,
    name: user.name,
    username: user.username || null,
    email: String(user.email || "").toLowerCase(),
    role: user.role,
    status: user.status || "Active",
    avatar: user.avatar || null,
    profile_image: user.profileImage || null,
    identity_number: user.legacyIdentityNumber ? null : user.identityNumber || "",
    passport_number: user.legacyPassportNumber ? null : user.passportNumber || "",
    date_of_birth: user.dateOfBirth || null,
    gender: user.gender || "",
    phone: user.phone || "",
    last_school: user.lastSchool || "",
    password_salt: user.passwordSalt || null,
    password_hash: user.passwordHash || null,
    recovery_question: user.recoveryQuestion || null,
    recovery_answer_hash: user.recoveryAnswerHash || null,
    last_login_at: user.lastLogin || null,
    attributes
  };
}

function fromSupabaseUser(row) {
  const attributes = row.attributes && typeof row.attributes === "object" ? { ...row.attributes } : {};
  const legacyIdentityNumber = attributes.__legacyIdentityNumber || "";
  const legacyPassportNumber = attributes.__legacyPassportNumber || "";
  delete attributes.__legacyIdentityNumber;
  delete attributes.__legacyPassportNumber;
  return {
    ...attributes,
    id: row.id,
    name: row.name,
    ...(row.username ? { username: row.username } : {}),
    email: row.email,
    role: row.role,
    status: row.status || "Active",
    ...(row.avatar ? { avatar: row.avatar } : {}),
    ...(row.profile_image ? { profileImage: row.profile_image } : {}),
    identityNumber: row.identity_number || legacyIdentityNumber,
    passportNumber: row.passport_number || legacyPassportNumber,
    ...(legacyIdentityNumber ? { legacyIdentityNumber } : {}),
    ...(legacyPassportNumber ? { legacyPassportNumber } : {}),
    dateOfBirth: row.date_of_birth || "",
    gender: row.gender || "",
    phone: row.phone || "",
    lastSchool: row.last_school || "",
    ...(row.password_salt ? { passwordSalt: row.password_salt } : {}),
    ...(row.password_hash ? { passwordHash: row.password_hash } : {}),
    ...(row.recovery_question ? { recoveryQuestion: row.recovery_question } : {}),
    ...(row.recovery_answer_hash ? { recoveryAnswerHash: row.recovery_answer_hash } : {}),
    ...(row.last_login_at ? { lastLogin: row.last_login_at } : {})
  };
}

async function readSupabaseUsers() {
  const rows = await supabaseRequest(supabaseUsersUrl("?select=*&order=created_at.asc"));
  if (!Array.isArray(rows)) throw new Error("Supabase users query returned an invalid response");
  return rows.map(fromSupabaseUser);
}

async function persistSupabaseUsers(users, previousUsers = []) {
  const previousById = new Map(previousUsers.map(user => [user.id, JSON.stringify(user)]));
  const currentIds = new Set(users.map(user => user.id));
  const changed = users.filter(user => previousById.get(user.id) !== JSON.stringify(user)).map(toSupabaseUser);
  if (changed.length) {
    try {
      await supabaseRequest(supabaseUsersUrl("?on_conflict=id"), {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify(changed)
      });
    } catch (error) {
      if (/attributes.*does not exist|column .*attributes/i.test(error.message)) {
        throw new Error("The Supabase users table needs its attributes column. Run backend/users-table-migration.sql in the Supabase SQL Editor, then restart the server.");
      }
      throw error;
    }
  }
  for (const user of previousUsers) {
    if (!currentIds.has(user.id)) {
      await supabaseRequest(supabaseUsersUrl(`?id=eq.${encodeURIComponent(user.id)}`), { method: "DELETE" });
    }
  }
}

async function readSupabaseState() {
  const rows = await supabaseRequest(supabaseStateUrl("?id=eq.main&select=id,state,revision"));
  return Array.isArray(rows) ? rows[0] || null : null;
}

async function initializeSupabaseState() {
  if (!supabaseConfigured) return;
  let record = await readSupabaseState();
  if (!record) {
    const seed = loadData();
    const inserted = await supabaseRequest(supabaseStateUrl(), {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({ id: "main", revision: 1, state: seed })
    });
    record = inserted?.[0] || null;
    if (!record) throw new Error("Supabase did not return the initialized LMS state row");
    console.log("Initialized Supabase LMS state from backend/data.json");
  }
  if (!record.state || typeof record.state !== "object" || Array.isArray(record.state)) {
    throw new Error("The Supabase LMS state row has an invalid state payload");
  }
  if (Array.isArray(record.state.users)) {
    const storedUsers = await readSupabaseUsers();
    const storedIds = new Set(storedUsers.map(user => user.id));
    const legacyUsers = record.state.users.filter(user => !storedIds.has(user.id));
    const takenIdentityNumbers = new Set(storedUsers.map(user => normalizeAccountNumber(user.identityNumber)).filter(Boolean));
    const takenPassportNumbers = new Set(storedUsers.map(user => normalizeAccountNumber(user.passportNumber)).filter(Boolean));
    for (const account of legacyUsers) {
      for (const [field, legacyField, taken] of [
        ["identityNumber", "legacyIdentityNumber", takenIdentityNumbers],
        ["passportNumber", "legacyPassportNumber", takenPassportNumbers]
      ]) {
        const value = normalizeAccountNumber(account[field]);
        if (!value) continue;
        if (taken.has(value)) account[legacyField] = account[field];
        taken.add(value);
      }
    }
    await persistSupabaseUsers(legacyUsers);
    const migratedState = { ...record.state };
    delete migratedState.users;
    await persistSupabaseState(migratedState, Number(record.revision));
    record = { ...record, state: migratedState, revision: Number(record.revision) + 1 };
    console.log(`Moved ${legacyUsers.length} existing account(s) from lms_state into the users table`);
  }
  console.log(`Supabase persistence ready (state revision ${record.revision})`);
}

async function persistSupabaseState(data, expectedRevision) {
  const revision = Number(expectedRevision);
  const state = { ...data };
  delete state.users;
  const updated = await supabaseRequest(supabaseStateUrl(`?id=eq.main&revision=eq.${revision}&select=revision`), {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({ state, revision: revision + 1, updated_at: new Date().toISOString() })
  });
  if (!Array.isArray(updated) || !updated.length) {
    const error = new Error("LMS data changed in another server session. Refresh and retry the action.");
    error.status = 409;
    throw error;
  }
}

function serveStatic(request, response, url) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.setHeader("Allow", "GET, HEAD");
    return send(response, 405, { error: "Method not allowed" });
  }

  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return send(response, 400, { error: "Invalid URL path" });
  }
  if (pathname.includes("\\") || pathname.includes("\0")) {
    return send(response, 400, { error: "Invalid URL path" });
  }

  const relativePath = pathname.replace(/^\/+/, "") || "index.html";
  const segments = relativePath.split("/");
  if (
    segments.some(segment => segment === "." || segment === "..") ||
    (segments[0] !== "index.html" && !STATIC_DIRECTORIES.has(segments[0])) ||
    (segments[0] === "index.html" && segments.length !== 1)
  ) {
    return send(response, 404, { error: "Not found" });
  }

  const filePath = path.resolve(STATIC_ROOT, relativePath);
  const relativeToRoot = path.relative(STATIC_ROOT, filePath);
  if (
    relativeToRoot === ".." ||
    relativeToRoot.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeToRoot)
  ) {
    return send(response, 404, { error: "Not found" });
  }

  let fileStats;
  try {
    fileStats = fs.statSync(filePath);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") {
      return send(response, 404, { error: "Not found" });
    }
    throw error;
  }
  if (!fileStats.isFile()) return send(response, 404, { error: "Not found" });

  response.writeHead(200, {
    "Content-Type": MIME_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream",
    "Content-Length": fileStats.size,
    "X-Content-Type-Options": "nosniff"
  });
  if (request.method === "HEAD") return response.end();

  const stream = fs.createReadStream(filePath);
  stream.on("error", error => {
    console.error(error);
    if (!response.headersSent) send(response, 500, { error: "Unable to serve file" });
    else response.destroy(error);
  });
  stream.pipe(response);
}

function readBody(request, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", chunk => {
      body += chunk;
      if (body.length > maxBytes) {
        reject(Object.assign(new Error("Request body is too large"), { status: 413 }));
        request.destroy();
      }
    });
    request.on("end", () => {
      if (!body) return resolve({});
      try { resolve(JSON.parse(body)); }
      catch { reject(Object.assign(new Error("Request body must be valid JSON"), { status: 400 })); }
    });
    request.on("error", reject);
  });
}

function courseNameKey(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function loginKey(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeAccountNumber(value) {
  return String(value || "").trim().toLowerCase();
}

function accountNumberInUse(users, field, value, excludeId = "") {
  const normalized = normalizeAccountNumber(value);
  return Boolean(normalized && users.some(account =>
    account.id !== excludeId && normalizeAccountNumber(account[field]) === normalized
  ));
}

function isDateKey(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(`${value}T00:00:00Z`)) &&
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

function isValidSouthAfricanId(value) {
  if (!/^\d{13}$/.test(value)) return false;
  const yearPart = Number(value.slice(0, 2));
  const currentYearPart = new Date().getUTCFullYear() % 100;
  const year = yearPart > currentYearPart ? 1900 + yearPart : 2000 + yearPart;
  const month = Number(value.slice(2, 4));
  const day = Number(value.slice(4, 6));
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return false;
  if (Number(value[10]) > 1) return false;
  let total = 0;
  for (let index = 0; index < 12; index++) {
    let digit = Number(value[index]);
    if (index % 2 === 0) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    total += digit;
  }
  return (10 - total % 10) % 10 === Number(value[12]);
}

function isMinor(dateOfBirth) {
  const birthDate = new Date(`${dateOfBirth}T00:00:00Z`);
  const today = new Date();
  let age = today.getUTCFullYear() - birthDate.getUTCFullYear();
  const birthdayHasPassed = today.getUTCMonth() > birthDate.getUTCMonth() ||
    (today.getUTCMonth() === birthDate.getUTCMonth() && today.getUTCDate() >= birthDate.getUTCDate());
  if (!birthdayHasPassed) age--;
  return age < 18;
}

function parseApplicationDocument(document, requiredKind) {
  if (!document || document.kind !== requiredKind) {
    throw Object.assign(new Error(`Upload the required ${requiredKind === "identity" ? "identity" : "academic qualification"} document`), { status: 400 });
  }
  const filename = path.basename(String(document.filename || "").replace(/\\/g, "/")).replace(/[\r\n"]/g, "_").slice(0, 120);
  const contentBase64 = String(document.contentBase64 || "");
  if (!filename || !contentBase64 || contentBase64.length > 7_000_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(contentBase64)) {
    throw Object.assign(new Error("Choose a valid document file"), { status: 400 });
  }
  const bytes = Buffer.from(contentBase64, "base64");
  if (!bytes.length || bytes.length > 5 * 1024 * 1024 || bytes.toString("base64") !== contentBase64) {
    throw Object.assign(new Error("Documents must be smaller than 5 MB"), { status: 400 });
  }
  const extension = path.extname(filename).toLowerCase();
  const signature = extension === ".pdf" && bytes.subarray(0, 5).toString("ascii") === "%PDF-"
    ? "application/pdf"
    : extension === ".png" && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      ? "image/png"
      : [".jpg", ".jpeg"].includes(extension) && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
        ? "image/jpeg"
        : "";
  if (!signature || (document.fileType && document.fileType !== signature && document.fileType !== "application/octet-stream")) {
    throw Object.assign(new Error("Documents must be valid PDF, JPG, JPEG, or PNG files"), { status: 400 });
  }
  return {
    id: crypto.randomUUID(),
    kind: requiredKind,
    filename,
    fileType: signature,
    fileSize: bytes.length,
    contentBase64
  };
}

function createApplicationReference(applications) {
  let referenceNumber;
  do {
    referenceNumber = `CHM-${new Date().getUTCFullYear()}-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
  } while (applications.some(application => application.referenceNumber === referenceNumber));
  return referenceNumber;
}

function requireRole(user, roles) {
  return Boolean(user && roles.includes(user.role));
}

function canManageCourse(user, course) {
  return user.role === "admin" || (
    user.role === "lecturer" &&
    (course.instructorId === user.id || course.instructor === user.name)
  );
}

function notify(data, userId, title, message, type = "update") {
  data.notifications.unshift({ id: crypto.randomUUID(), userId, title, message, type, read: false, createdAt: new Date().toISOString() });
}
function recordActivity(data, user, action, affectedIds = []) {
  data.audit_log.unshift({ id: crypto.randomUUID(), time: new Date().toISOString(), user: user.email, role: user.role, action, status: "Success" });
  data.audit_log = data.audit_log.slice(0, 5000);
  affectedIds.filter(Boolean).forEach(id => notify(data, id, "LMS activity", action));
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  return { salt, hash: crypto.scryptSync(password, salt, 64).toString("hex") };
}

function handle(request, response) {
  const context = { data: null, revision: null, dirty: false, originalUsers: null };
  return requestContext.run(context, () => handleRequest(request, response));
}

async function handleRequest(request, response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS");
  if (request.method === "OPTIONS") {
    response.writeHead(204);
    return response.end();
  }

  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  const route = url.pathname.replace(/\/$/, "") || "/";
  if (!route.startsWith("/api/")) return serveStatic(request, response, url);
  if (route === "/api/health") return send(response, 200, {
    status: "ok",
    service: "Chimera LMS JavaScript API",
    persistence: supabaseConfigured ? "supabase" : "json-file"
  });

  const context = requestContext.getStore();
  if (supabaseConfigured) {
    const record = await readSupabaseState();
    if (!record) return send(response, 503, { error: "Supabase LMS state has not been initialized" });
    context.data = record.state;
    context.revision = Number(record.revision);
    context.data.users = await readSupabaseUsers();
    context.originalUsers = structuredClone(context.data.users);
  } else {
    context.data = loadData();
  }
  const data = loadData();
  const authorization = request.headers.authorization || "";
  const tokenUser = verifyToken(authorization.startsWith("Bearer ") ? authorization.slice(7) : "");
  const user = tokenUser ? data.users.find(account => account.id === tokenUser.id && account.status !== "Inactive") || null : null;

  if (request.method === "POST" && route === "/api/auth/login") {
    const body = await readBody(request);
    const requestedRole = String(body.role || "");
    if (requestedRole && !["learner", "lecturer", "admin"].includes(requestedRole)) {
      return send(response, 400, { error: "Choose a valid account type" });
    }
    const username = loginKey(body.username || body.email);
    const account = data.users.find(item =>
      loginKey(item.email) === username ||
      (item.username && loginKey(item.username) === username) ||
      (!item.username && loginKey(item.name) === username)
    );
    const isDemoAccount = Boolean(account && account.demo);
    if (!account || (!isDemoAccount && (!account.passwordSalt || !account.passwordHash))) {
      return send(response, 401, { error: "No registered account was found for that username or email" });
    }
    if (requestedRole && account.role !== requestedRole) {
      return send(response, 401, { error: "The selected account type does not match this account" });
    }
    const password = String(body.password || "");
    const validDemoPassword = isDemoAccount && password === "demo";
    const hasRegisteredPassword = Boolean(account.passwordSalt && account.passwordHash);
    const supplied = hasRegisteredPassword ? hashPassword(password, account.passwordSalt).hash : "";
    const suppliedBuffer = Buffer.from(supplied, "hex");
    const storedBuffer = Buffer.from(account.passwordHash || "", "hex");
    const validRegisteredPassword = hasRegisteredPassword && suppliedBuffer.length === storedBuffer.length && crypto.timingSafeEqual(suppliedBuffer, storedBuffer);
    if (!validDemoPassword && !validRegisteredPassword) {
      return send(response, 401, { error: "Incorrect username/email or password" });
    }
    if (account.status === "Pending" && account.role === "learner") {
      return send(response, 403, { error: "Your learner application is waiting for administrator approval. Please try again after it has been approved." });
    }
    if (account.status === "Inactive" || account.status === "Rejected") {
      return send(response, 403, { error: "This account is inactive or was not approved. Contact an administrator." });
    }
    if (isDemoAccount) {
      const { salt, hash } = hashPassword(password);
      account.passwordSalt = salt;
      account.passwordHash = hash;
      delete account.demo;
    }
    if (isDemoAccount && account.role === "learner" && !account.selectedCourse && data.courses.length) {
      account.selectedCourse = data.courses[0].title;
    }
    account.lastLogin = new Date().toISOString();
    saveData(data);
    return send(response, 200, { token: makeToken(account), user: publicUser(account) });
  }

  if (request.method === "POST" && route === "/api/auth/register") {
    const body = await readBody(request, 24 * 1024 * 1024);
    const username = String(body.username || "").trim();
    const firstName = String(body.firstName || "").trim();
    const surname = String(body.surname || "").trim();
    const name = `${firstName} ${surname}`.trim();
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    const identityNumber = String(body.identityNumber || "").trim();
    const passportNumber = String(body.passportNumber || "").trim();
    const dateOfBirth = String(body.dateOfBirth || "").trim();
    const phone = String(body.phone || "").trim();
    if (!/^[A-Za-z0-9._-]{3,30}$/.test(username)) return send(response, 400, { error: "Username must be 3–30 letters, numbers, dots, underscores, or hyphens" });
    if (!firstName || !surname || firstName.length > 80 || surname.length > 80) return send(response, 400, { error: "Enter a valid first name and surname" });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return send(response, 400, { error: "Enter a valid email address" });
    if (String(body.emailConfirm || "").trim().toLowerCase() !== email) return send(response, 400, { error: "Email addresses do not match" });
    if (data.users.some(item => loginKey(item.email) === email)) return send(response, 409, { error: "An account with this email already exists" });
    if (data.users.some(item =>
      loginKey(item.username) === loginKey(username) ||
      loginKey(item.email) === loginKey(username) ||
      (!item.username && loginKey(item.name) === loginKey(username))
    )) return send(response, 409, { error: "That username is already in use" });
    if (password !== String(body.passwordConfirm || "")) return send(response, 400, { error: "Passwords do not match" });
    if (password.length < 8) return send(response, 400, { error: "Password must have at least 8 characters" });
    if (!dateOfBirth || !isDateKey(dateOfBirth) || dateOfBirth >= new Date().toISOString().slice(0, 10)) return send(response, 400, { error: "Enter a valid date of birth" });
    if (!phone || !/^\+?[0-9][0-9\s()-]{6,19}$/.test(phone)) return send(response, 400, { error: "Enter a valid contact phone number" });
    if (!["female", "male", "prefer-not-to-say"].includes(String(body.gender || ""))) return send(response, 400, { error: "Choose a gender option" });
    if (identityNumber && !isValidSouthAfricanId(identityNumber)) return send(response, 400, { error: "Enter a valid 13-digit South African ID number or use your passport number" });
    if (!identityNumber && !/^[A-Za-z0-9][A-Za-z0-9 -]{4,19}$/.test(passportNumber)) return send(response, 400, { error: "Enter a valid identity or passport number" });
    if (accountNumberInUse(data.users, "identityNumber", identityNumber)) return send(response, 409, { error: "That identity number is already registered" });
    if (accountNumberInUse(data.users, "passportNumber", passportNumber)) return send(response, 409, { error: "That passport number is already registered" });
    if (isMinor(dateOfBirth) && (!String(body.guardianName || "").trim() || !String(body.guardianPhone || "").trim())) {
      return send(response, 400, { error: "Guardian name and phone number are required for learners under 18" });
    }
    if (!String(body.highestQualification || "").trim() || !String(body.lastSchool || "").trim()) return send(response, 400, { error: "Enter your highest qualification and most recent school" });
    if (!body.agreement || !String(body.recoveryQuestion || "").trim() || !String(body.recoveryAnswer || "").trim()) return send(response, 400, { error: "Complete the recovery details and accept the registration agreement" });
    const selectedProgramme = data.courses.find(course => courseNameKey(course.title) === courseNameKey(body.course));
    if (!selectedProgramme) return send(response, 400, { error: "Choose one of the available certificate programmes" });
    const documents = Array.isArray(body.documents) ? body.documents : [];
    if (documents.filter(document => document.kind === "identity").length !== 1 || documents.filter(document => document.kind === "qualification").length !== 1 || documents.length > 3) {
      return send(response, 400, { error: "Upload one identity document and one academic qualification document" });
    }
    const storedDocuments = [
      parseApplicationDocument(documents.find(document => document.kind === "identity"), "identity"),
      parseApplicationDocument(documents.find(document => document.kind === "qualification"), "qualification")
    ];
    if (documents.some(document => document.kind === "additional")) storedDocuments.push(parseApplicationDocument(documents.find(document => document.kind === "additional"), "additional"));

    const now = new Date().toISOString();
    const { salt, hash } = hashPassword(password);
    const learner = {
      id: crypto.randomUUID(), name, firstName, surname, username, email, role: "learner",
      avatar: name.split(/\s+/).slice(0, 2).map(part => part[0]).join("").toUpperCase(),
      status: "Pending", passwordSalt: salt, passwordHash: hash,
      identityNumber, passportNumber, dateOfBirth, phone, lastSchool: String(body.lastSchool).trim(),
      gender: String(body.gender),
      highestQualification: String(body.highestQualification).trim(), residenceAddress: String(body.residenceAddress || "").trim(),
      guardianName: String(body.guardianName || "").trim(), guardianPhone: String(body.guardianPhone || "").trim(),
      recoveryQuestion: String(body.recoveryQuestion).trim(),
      recoveryAnswerHash: crypto.createHash("sha256").update(String(body.recoveryAnswer).trim().toLowerCase()).digest("hex"),
      moduleProgress: {}, selectedCourse: selectedProgramme.title, createdAt: now
    };
    const application = {
      id: crypto.randomUUID(), referenceNumber: createApplicationReference(data.program_applications),
      userId: learner.id, course: learner.selectedCourse, courseId: selectedProgramme.id,
      status: "pending", submittedAt: now, reviewedBy: null, reviewedAt: null, reviewNote: "",
      notificationStatus: { inApp: "pending", email: "not_configured" }, documents: storedDocuments,
      highestQualification: learner.highestQualification, lastSchool: learner.lastSchool,
      residenceAddress: learner.residenceAddress, guardianName: learner.guardianName, guardianPhone: learner.guardianPhone
    };
    data.users.push(learner);
    data.program_applications.push(application);
    recordActivity(data, learner, `Submitted enrolment application ${application.referenceNumber} for ${learner.selectedCourse}`, data.users.filter(item => item.role === "admin").map(item => item.id));
    saveData(data);
    return send(response, 201, {
      pendingApproval: true,
      applicationReference: application.referenceNumber,
      submittedAt: application.submittedAt,
      message: "Your profile and enrolment application have been submitted successfully. Your application is awaiting administrator review."
    });
  }

  if (request.method === "POST" && route === "/api/auth/recover") {
    const body = await readBody(request);
    const email = loginKey(body.email);
    const recoveryQuestion = String(body.recoveryQuestion || "").trim();
    const answerHash = crypto.createHash("sha256").update(String(body.recoveryAnswer || "").trim().toLowerCase()).digest("hex");
    const password = String(body.password || "");
    if (password.length < 8) return send(response, 400, { error: "Password must have at least 8 characters" });
    const account = data.users.find(item =>
      loginKey(item.email) === email &&
      item.recoveryQuestion &&
      loginKey(item.recoveryQuestion) === loginKey(recoveryQuestion) &&
      item.recoveryAnswerHash &&
      item.recoveryAnswerHash === answerHash
    );
    if (!account) return send(response, 400, { error: "Email, recovery question, and answer could not be verified" });
    const { salt, hash } = hashPassword(password);
    account.passwordSalt = salt;
    account.passwordHash = hash;
    saveData(data);
    return send(response, 200, { status: "ok" });
  }

  if (request.method === "POST" && route === "/api/auth/track") {
    const body = await readBody(request);
    const identifier = String(body.identifier || "").trim();
    const password = String(body.password || "");
    if (!identifier || !password) return send(response, 400, { error: "Enter your application identifier and account password" });
    const normalizedIdentifier = loginKey(identifier);
    const referenceMatch = data.program_applications.find(application => loginKey(application.referenceNumber) === normalizedIdentifier);
    const account = referenceMatch
      ? data.users.find(item => item.id === referenceMatch.userId && item.role === "learner")
      : data.users.find(item => item.role === "learner" && (
        loginKey(item.email) === normalizedIdentifier ||
        loginKey(item.identityNumber || "") === normalizedIdentifier ||
        loginKey(item.passportNumber || "") === normalizedIdentifier
      ));
    const storedApplication = account && data.program_applications.find(application => application.userId === account.id);
    const suppliedHash = account?.passwordSalt ? hashPassword(password, account.passwordSalt).hash : "";
    const suppliedBuffer = Buffer.from(suppliedHash, "hex");
    const storedBuffer = Buffer.from(account?.passwordHash || "", "hex");
    if (!account || !storedApplication || suppliedBuffer.length !== storedBuffer.length || !storedBuffer.length || !crypto.timingSafeEqual(suppliedBuffer, storedBuffer)) {
      return send(response, 401, { error: "The application identifier or password could not be verified" });
    }
    const needsReference = !storedApplication.referenceNumber;
    if (needsReference) storedApplication.referenceNumber = createApplicationReference(data.program_applications);
    const statusLabels = { pending: "Pending Admin Approval", approved: "Approved", rejected: "Rejected" };
    const status = statusLabels[storedApplication.status] || "Pending Admin Approval";
    const nextStep = status === "Approved"
      ? "Your enrolment application has been approved. Sign in to continue to your learner dashboard."
      : status === "Rejected"
        ? "Review the administrator feedback below or contact Chimera Learning for assistance."
        : "Your application is awaiting administrator review. You will be notified when a decision is made.";
    if (needsReference) saveData(data);
    return send(response, 200, {
      application: {
        referenceNumber: storedApplication.referenceNumber,
        status,
        course: storedApplication.course || account.selectedCourse || "—",
        submittedAt: storedApplication.submittedAt || null,
        reviewNote: storedApplication.reviewNote || "",
        nextStep
      }
    });
  }

  if (!user) return send(response, 401, { error: "Unauthorized" });
  if (user.role === "learner" && user.status !== "Active") return send(response, 403, { error: "Your learner account is not approved for dashboard access yet" });
  if (route === "/api/admin/applications" && request.method === "GET") {
    if (!requireRole(user, ["admin"])) return send(response, 403, { error: "Forbidden" });
    const applications = (data.program_applications || []).slice().sort((left, right) => String(right.submittedAt || "").localeCompare(String(left.submittedAt || ""))).map(application => {
      const learner = data.users.find(account => account.id === application.userId);
      return {
        id: application.id,
        referenceNumber: application.referenceNumber || "Legacy application",
        name: learner?.name || "Unknown learner",
        email: learner?.email || "",
        course: application.course || learner?.selectedCourse || "—",
        status: application.status || "pending",
        submittedAt: application.submittedAt || null,
        documentCount: Array.isArray(application.documents) ? application.documents.length : 0
      };
    });
    return send(response, 200, applications);
  }
  const applicationDocumentMatch = route.match(/^\/api\/admin\/applications\/([^/]+)\/documents\/([^/]+)$/);
  if (applicationDocumentMatch && request.method === "GET") {
    if (!requireRole(user, ["admin"])) return send(response, 403, { error: "Forbidden" });
    const application = (data.program_applications || []).find(item => item.id === applicationDocumentMatch[1]);
    const document = application?.documents?.find(item => item.id === applicationDocumentMatch[2]);
    if (!document) return send(response, 404, { error: "Application document not found" });
    const bytes = Buffer.from(document.contentBase64 || "", "base64");
    const filename = String(document.filename || "application-document").replace(/[^A-Za-z0-9._-]/g, "_");
    response.writeHead(200, {
      "Content-Type": document.fileType,
      "Content-Length": bytes.length,
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff"
    });
    return response.end(bytes);
  }
  const applicationDetailMatch = route.match(/^\/api\/admin\/applications\/([^/]+)$/);
  if (applicationDetailMatch && request.method === "GET") {
    if (!requireRole(user, ["admin"])) return send(response, 403, { error: "Forbidden" });
    const application = (data.program_applications || []).find(item => item.id === applicationDetailMatch[1]);
    if (!application) return send(response, 404, { error: "Application not found" });
    const learner = data.users.find(account => account.id === application.userId);
    if (!learner) return send(response, 404, { error: "Applicant account not found" });
    return send(response, 200, {
      application: {
        id: application.id,
        referenceNumber: application.referenceNumber || "Legacy application",
        status: application.status || "pending",
        course: application.course || learner.selectedCourse || "—",
        submittedAt: application.submittedAt || null,
        reviewedAt: application.reviewedAt || null,
        reviewNote: application.reviewNote || "",
        documents: (application.documents || []).map(({ id, kind, filename, fileType, fileSize }) => ({ id, kind, filename, fileType, fileSize }))
      },
      learner: {
        id: learner.id,
        firstName: learner.firstName || learner.name.split(/\s+/)[0],
        surname: learner.surname || learner.name.split(/\s+/).slice(1).join(" "),
        email: learner.email,
        identityNumber: learner.identityNumber || "",
        passportNumber: learner.passportNumber || "",
        dateOfBirth: learner.dateOfBirth || "",
        phone: learner.phone || "",
        highestQualification: application.highestQualification || learner.highestQualification || "",
        lastSchool: application.lastSchool || learner.lastSchool || "",
        residenceAddress: application.residenceAddress || learner.residenceAddress || "",
        guardianName: application.guardianName || learner.guardianName || "",
        guardianPhone: application.guardianPhone || learner.guardianPhone || ""
      }
    });
  }
  const applicationDecisionMatch = route.match(/^\/api\/admin\/applications\/([^/]+)\/decision$/);
  if (applicationDecisionMatch && request.method === "POST") {
    if (!requireRole(user, ["admin"])) return send(response, 403, { error: "Forbidden" });
    const body = await readBody(request, 16 * 1024);
    const application = (data.program_applications || []).find(item => item.id === applicationDecisionMatch[1]);
    if (!application) return send(response, 404, { error: "Application not found" });
    if (application.status !== "pending") return send(response, 409, { error: "This application has already been reviewed" });
    const decision = String(body.decision || "");
    const reviewNote = String(body.feedback || "").trim().slice(0, 1000);
    if (!["approved", "rejected"].includes(decision)) return send(response, 400, { error: "Choose approve or reject" });
    if (decision === "rejected" && reviewNote.length < 4) return send(response, 400, { error: "Enter a reason before rejecting this application" });
    const learner = data.users.find(account => account.id === application.userId);
    if (!learner) return send(response, 404, { error: "Applicant account not found" });
    const reviewedAt = new Date().toISOString();
    application.status = decision;
    application.reviewedBy = user.id;
    application.reviewedAt = reviewedAt;
    application.reviewNote = reviewNote;
    application.notificationStatus = { inApp: "sent", email: "not_configured" };
    if (decision === "approved") {
      learner.status = "Active";
      const course = data.courses.find(item => item.id === application.courseId || courseNameKey(item.title) === courseNameKey(application.course));
      if (course && !data.enrollments.some(enrollment => enrollment.userId === learner.id && enrollment.courseId === course.id)) {
        data.enrollments.push({ userId: learner.id, courseId: course.id, status: "active", enrolledAt: reviewedAt, managedBy: user.id });
      }
    } else {
      learner.status = "Rejected";
    }
    const message = decision === "approved"
      ? `Your application ${application.referenceNumber} for ${application.course} has been approved. Sign in to continue to your learner dashboard.`
      : `Your application ${application.referenceNumber} was not approved. Administrator feedback: ${reviewNote}`;
    notify(data, learner.id, decision === "approved" ? "Enrolment application approved" : "Enrolment application decision", message, "application");
    recordActivity(data, user, `${decision === "approved" ? "Approved" : "Rejected"} application ${application.referenceNumber} for ${learner.email}`);
    saveData(data);
    return send(response, 200, {
      application: { id: application.id, referenceNumber: application.referenceNumber, status: application.status, reviewedAt },
      notifications: { inApp: "sent", email: "not_configured" }
    });
  }
  if (request.method === "GET" && route === "/api/me") {
    const account = data.users.find(item => item.id === user.id);
    return send(response, 200, profileUser(account));
  }
  if (route === "/api/notifications" && request.method === "GET") return send(response, 200, data.notifications.filter(n => n.userId === user.id));
  if (route === "/api/notifications/read" && request.method === "POST") {
    const body = await readBody(request);
    data.notifications.filter(n => n.userId === user.id && (!body.id || n.id === body.id)).forEach(n => n.read = true);
    saveData(data); return send(response, 200, { status: "ok" });
  }
  if (route === "/api/announcements" && request.method === "GET") {
    const enrolledIds = new Set(data.enrollments.filter(e => e.userId === user.id).map(e => e.courseId));
    const profile = data.users.find(u => u.id === user.id);
    const learnerCourses = new Set(data.courses.filter(c => courseNameKey(c.title) === courseNameKey(profile?.selectedCourse)).map(c => c.id));
    const visible = data.announcements.filter(a => {
      const audienceMatches = a.audience === "all" || !a.audience || a.audience === user.role;
      const scopeMatches = a.scope === "system" ||
        (user.role === "learner" && (enrolledIds.has(a.courseId) || learnerCourses.has(a.courseId))) ||
        (user.role === "lecturer" && data.courses.some(c => c.id === a.courseId && canManageCourse(user, c)));
      return audienceMatches && scopeMatches;
    });
    return send(response, 200, visible);
  }
  if (route === "/api/announcements" && request.method === "POST") {
    if (!requireRole(user, ["admin", "lecturer"])) return send(response, 403, { error: "Forbidden" });
    const body = await readBody(request), title = String(body.title || "").trim(), message = String(body.message || "").trim();
    if (!title || !message) return send(response, 400, { error: "Announcement title and message are required" });
    const course = body.courseId ? data.courses.find(c => c.id === body.courseId) : null;
    if (user.role === "lecturer" && (!course || !canManageCourse(user, course))) return send(response, 403, { error: "Choose one of your courses" });
    const audience = user.role === "admin" && ["learner", "lecturer"].includes(body.audience) ? body.audience : "all";
    const announcement = { id: crypto.randomUUID(), title, message, audience, courseId: course?.id || null, scope: user.role === "admin" && !course ? "system" : "course", createdBy: user.id, createdAt: new Date().toISOString() };
    data.announcements.unshift(announcement);
    const recipients = announcement.scope === "system" ? data.users.filter(u => u.id !== user.id && (audience === "all" || u.role === audience)).map(u => u.id) : data.users.filter(u => u.role === "learner" && (courseNameKey(u.selectedCourse) === courseNameKey(course.title) || data.enrollments.some(e => e.userId === u.id && e.courseId === course.id))).map(u => u.id);
    recordActivity(data, user, `Posted announcement: ${title}`, recipients); saveData(data); return send(response, 201, announcement);
  }
  if (route === "/api/messages" && request.method === "GET") {
    return send(response, 200, data.messages.filter(m => m.senderId === user.id || m.recipientId === user.id).map(m => ({ ...m, senderName: data.users.find(u => u.id === m.senderId)?.name || "User", recipientName: data.users.find(u => u.id === m.recipientId)?.name || "User" })));
  }
  if (route === "/api/messages" && request.method === "POST") {
    if (!requireRole(user, ["learner", "lecturer"])) return send(response, 403, { error: "Only learners and lecturers can message" });
    const body = await readBody(request), course = data.courses.find(c => c.id === body.courseId), message = String(body.message || "").trim();
    if (!course || !message || message.length > 4000) return send(response, 400, { error: "Choose a course and enter a message (up to 4,000 characters)" });
    let recipient;
    if (user.role === "learner") {
      const learner = data.users.find(u => u.id === user.id);
      if (!(data.enrollments.some(e => e.userId === user.id && e.courseId === course.id) || courseNameKey(learner?.selectedCourse) === courseNameKey(course.title))) return send(response, 403, { error: "Enroll in this course before messaging its lecturer" });
      recipient = data.users.find(u => u.id === course.instructorId) || data.users.find(u => u.role === "lecturer" && u.name === course.instructor);
    } else {
      if (!canManageCourse(user, course) || !body.recipientId) return send(response, 403, { error: "Choose an enrolled learner in your course" });
      const learner = data.users.find(u => u.id === body.recipientId && u.role === "learner");
      const enrolled = learner && (data.enrollments.some(e => e.userId === learner.id && e.courseId === course.id) || courseNameKey(learner.selectedCourse) === courseNameKey(course.title));
      recipient = enrolled ? learner : null;
    }
    if (!recipient) return send(response, 404, { error: "Course lecturer or learner not found" });
    const item = { id: crypto.randomUUID(), courseId: course.id, senderId: user.id, recipientId: recipient.id, message, createdAt: new Date().toISOString(), read: false };
    data.messages.unshift(item); recordActivity(data, user, `Sent a course message for ${course.title}`, [recipient.id]); saveData(data); return send(response, 201, item);
  }
  if (route === "/api/courses/publish" && request.method === "POST") {
    if (!requireRole(user, ["lecturer"])) return send(response, 403, { error: "Only lecturers can publish courses" });
    const body = await readBody(request), title = String(body.title || "").trim(), code = String(body.code || "").trim().toUpperCase();
    if (!title || !code) return send(response, 400, { error: "Course title and code are required" });
    if (data.courses.some(c => c.code?.toLowerCase() === code.toLowerCase())) return send(response, 409, { error: "Course code is already in use" });
    const course = { id: crypto.randomUUID(), code, title, instructor: user.name, instructorId: user.id, status: "pending", students: 0, modules: {} };
    data.courses.push(course); recordActivity(data, user, `Published course ${title} for admin approval`, data.users.filter(u => u.role === "admin").map(u => u.id)); saveData(data);
    return send(response, 201, course);
  }
  if (route === "/api/courses/decision" && request.method === "POST") {
    if (!requireRole(user, ["admin"])) return send(response, 403, { error: "Forbidden" });
    const body = await readBody(request), course = data.courses.find(c => c.id === body.courseId);
    if (!course || course.status !== "pending") return send(response, 404, { error: "Pending course not found" });
    course.status = body.approved ? "active" : "rejected";
    recordActivity(data, user, `${body.approved ? "Approved" : "Rejected"} course ${course.title}`, [course.instructorId]); saveData(data);
    return send(response, 200, course);
  }
  if (route === "/api/courses/manage" && request.method === "POST") {
    if (!requireRole(user, ["admin"])) return send(response, 403, { error: "Forbidden" });
    const body = await readBody(request), course = data.courses.find(c => c.id === body.courseId);
    if (!course) return send(response, 404, { error: "Course not found" });
    if (body.action === "reassign") {
      const lecturer = data.users.find(u => u.id === body.lecturerId && u.role === "lecturer" && u.status !== "Inactive");
      if (!lecturer) return send(response, 400, { error: "Choose an active lecturer" });
      course.instructorId = lecturer.id; course.instructor = lecturer.name;
      const learners = data.users.filter(u => u.role === "learner" && (courseNameKey(u.selectedCourse) === courseNameKey(course.title) || data.enrollments.some(e => e.userId === u.id && e.courseId === course.id))).map(u => u.id);
      recordActivity(data, user, `Reassigned ${course.title} to ${lecturer.name}`, [lecturer.id, ...learners]);
    } else if (body.action === "archive") {
      course.status = "archived";
      const learners = data.users.filter(u => u.role === "learner" && (courseNameKey(u.selectedCourse) === courseNameKey(course.title) || data.enrollments.some(e => e.userId === u.id && e.courseId === course.id))).map(u => u.id);
      recordActivity(data, user, `Archived course ${course.title}`, [course.instructorId, ...learners]);
    } else return send(response, 400, { error: "Choose reassign or archive" });
    saveData(data); return send(response, 200, course);
  }
  if (route === "/api/enrollments" && request.method === "POST") {
    const body = await readBody(request), course = data.courses.find(c => c.id === body.courseId);
    if (!course || ["pending", "rejected", "archived"].includes(course.status)) return send(response, 404, { error: "Course is not open for enrolment" });
    if (user.role === "admin" && body.userId) {
      const learner = data.users.find(u => u.id === body.userId && u.role === "learner" && u.status !== "Inactive");
      if (!learner) return send(response, 404, { error: "Active learner not found" });
      if (body.action === "remove") {
        data.enrollments = data.enrollments.filter(e => !(e.userId === learner.id && e.courseId === course.id));
        if (courseNameKey(learner.selectedCourse) === courseNameKey(course.title)) learner.selectedCourse = "";
      }
      else if (!data.enrollments.some(e => e.userId === learner.id && e.courseId === course.id)) data.enrollments.push({ userId: learner.id, courseId: course.id, enrolledAt: new Date().toISOString() });
      course.students = data.users.filter(u => u.role === "learner" && (courseNameKey(u.selectedCourse) === courseNameKey(course.title) || data.enrollments.some(e => e.userId === u.id && e.courseId === course.id))).length;
      recordActivity(data, user, `${body.action === "remove" ? "Removed" : "Enrolled"} ${learner.name} ${body.action === "remove" ? "from" : "in"} ${course.title}`, [learner.id, course.instructorId]);
      saveData(data); return send(response, 200, { status: "ok" });
    }
    if (!requireRole(user, ["learner"])) return send(response, 403, { error: "Forbidden" });
    const learner = data.users.find(u => u.id === user.id);
    const enrolled = data.enrollments.some(e => e.userId === user.id && e.courseId === course.id) || courseNameKey(learner?.selectedCourse) === courseNameKey(course.title);
    if (body.action === "leave") {
      data.enrollments = data.enrollments.filter(e => !(e.userId === user.id && e.courseId === course.id));
      if (courseNameKey(learner.selectedCourse) === courseNameKey(course.title)) learner.selectedCourse = "";
      recordActivity(data, user, `Left ${course.title}`, [course.instructorId]);
    } else if (!enrolled) {
      data.enrollments.push({ userId: user.id, courseId: course.id, enrolledAt: new Date().toISOString() });
      recordActivity(data, user, `Enrolled in ${course.title}`, [course.instructorId]);
    }
    course.students = data.users.filter(u => u.role === "learner" && (courseNameKey(u.selectedCourse) === courseNameKey(course.title) || data.enrollments.some(e => e.userId === u.id && e.courseId === course.id))).length;
    saveData(data); return send(response, 200, { status: "ok" });
  }
  if (route === "/api/lessons" && request.method === "POST") {
    if (!requireRole(user, ["lecturer"])) return send(response, 403, { error: "Only lecturers can add lessons" });
    const body = await readBody(request), course = data.courses.find(c => c.id === body.courseId), group = String(body.group || "Lessons").trim().slice(0, 80), title = String(body.title || "").trim().slice(0, 180);
    if (!course || !canManageCourse(user, course)) return send(response, 403, { error: "You cannot manage this course" });
    if (!title) return send(response, 400, { error: "Lesson title is required" });
    if (!course.modules || typeof course.modules !== "object") course.modules = {};
    if (!Array.isArray(course.modules[group])) course.modules[group] = [];
    course.modules[group].push(title);
    const recipients = data.users.filter(u => u.role === "learner" && (courseNameKey(u.selectedCourse) === courseNameKey(course.title) || data.enrollments.some(e => e.userId === u.id && e.courseId === course.id))).map(u => u.id);
    recordActivity(data, user, `Added lesson ${title} to ${course.title}`, recipients); saveData(data); return send(response, 201, { courseId: course.id, group, title });
  }
  if (route === "/api/lessons/delete" && request.method === "POST") {
    if (!requireRole(user, ["lecturer"])) return send(response, 403, { error: "Only lecturers can delete lessons" });
    const body = await readBody(request), course = data.courses.find(c => c.id === body.courseId), group = String(body.group || ""), index = Number(body.index);
    if (!course || !canManageCourse(user, course) || !Array.isArray(course.modules?.[group]) || !Number.isInteger(index) || index < 0 || index >= course.modules[group].length) return send(response, 404, { error: "Lesson not found" });
    const [title] = course.modules[group].splice(index, 1);
    if (!course.modules[group].length) delete course.modules[group];
    data.materials = (data.materials || []).filter(material =>
      material.courseId !== course.id || material.group !== group || Number(material.moduleIndex) !== index
    ).map(material => material.courseId === course.id && material.group === group && Number(material.moduleIndex) > index
      ? { ...material, moduleIndex: Number(material.moduleIndex) - 1 }
      : material);
    data.users.filter(learner => learner.role === "learner").forEach(learner => {
      for (const field of ["moduleProgress", "moduleNotes"]) {
        const values = learner[field]?.[course.id]?.[group];
        if (!values || typeof values !== "object") continue;
        const shifted = {};
        for (const [key, value] of Object.entries(values)) {
          const oldIndex = Number(key);
          if (Number.isInteger(oldIndex) && oldIndex < index) shifted[oldIndex] = value;
          else if (Number.isInteger(oldIndex) && oldIndex > index) shifted[oldIndex - 1] = value;
        }
        learner[field][course.id][group] = shifted;
      }
    });
    const recipients = data.users.filter(u => u.role === "learner" && (courseNameKey(u.selectedCourse) === courseNameKey(course.title) || data.enrollments.some(e => e.userId === u.id && e.courseId === course.id))).map(u => u.id);
    recordActivity(data, user, `Removed lesson ${title} from ${course.title}`, recipients); saveData(data); return send(response, 200, { status: "ok" });
  }
  if (route === "/api/assignments/delete" && request.method === "POST") {
    if (!requireRole(user, ["lecturer", "admin"])) return send(response, 403, { error: "Forbidden" });
    const body = await readBody(request), index = data.assignments.findIndex(a => a.id === body.assignmentId), assignment = data.assignments[index], course = assignment && data.courses.find(c => c.id === assignment.courseId);
    if (!assignment || !course || !canManageCourse(user, course)) return send(response, 404, { error: "Assessment not found" });
    data.assignments.splice(index, 1); data.submissions = data.submissions.filter(s => s.assignmentId !== assignment.id);
    recordActivity(data, user, `Deleted ${assignment.type || "assessment"} ${assignment.title}`, data.users.filter(u => u.role === "learner" && (courseNameKey(u.selectedCourse) === courseNameKey(course.title) || data.enrollments.some(e => e.userId === u.id && e.courseId === course.id))).map(u => u.id));
    saveData(data); return send(response, 200, { status: "ok" });
  }
  if (route === "/api/quiz/submit" && request.method === "POST") {
    if (!requireRole(user, ["learner"])) return send(response, 403, { error: "Only learners can take quizzes" });
    const body = await readBody(request), assignment = data.assignments.find(a => a.id === body.assignmentId && String(a.type).toLowerCase() === "quiz");
    if (!assignment || !Array.isArray(assignment.quiz?.questions)) return send(response, 404, { error: "Quiz not found" });
    const learner = data.users.find(u => u.id === user.id), enrolled = data.enrollments.some(e => e.userId === user.id && e.courseId === assignment.courseId) || courseNameKey(learner?.selectedCourse) === courseNameKey(data.courses.find(c => c.id === assignment.courseId)?.title);
    if (!enrolled) return send(response, 403, { error: "Enroll in this course to take the quiz" });
    if (data.submissions.some(s => s.userId === user.id && s.assignmentId === assignment.id)) return send(response, 409, { error: "You have already completed this quiz" });
    const answers = Array.isArray(body.answers) ? body.answers : [];
    if (answers.length !== assignment.quiz.questions.length || answers.some((answer, i) => !Number.isInteger(Number(answer)) || Number(answer) < 0 || Number(answer) >= assignment.quiz.questions[i].options.length)) return send(response, 400, { error: "Answer every quiz question" });
    const correct = assignment.quiz.questions.reduce((count, q, i) => count + (Number(answers[i]) === Number(q.answer) ? 1 : 0), 0), score = Math.round(correct / assignment.quiz.questions.length * 100);
    const submission = { id: crypto.randomUUID(), userId: user.id, assignmentId: assignment.id, comments: "Quiz submitted", filename: "Quiz answers", fileType: "application/json", fileSize: 0, fileContent: "", submittedAt: new Date().toISOString(), score, feedback: `${correct} of ${assignment.quiz.questions.length} correct`, gradedAt: new Date().toISOString() };
    data.submissions.push(submission); recordActivity(data, user, `Completed quiz ${assignment.title}: ${score}%`, [user.id, data.courses.find(c => c.id === assignment.courseId)?.instructorId]); saveData(data);
    return send(response, 201, { score, feedback: submission.feedback });
  }
  if (route === "/api/progress" && request.method === "GET") {
    if (!requireRole(user, ["lecturer", "admin"])) return send(response, 403, { error: "Forbidden" });
    const course = data.courses.find(c => c.id === url.searchParams.get("courseId"));
    if (!course || !canManageCourse(user, course)) return send(response, 403, { error: "You cannot view this course" });
    const enrolledIds = new Set([...data.enrollments.filter(e => e.courseId === course.id).map(e => e.userId), ...data.users.filter(u => courseNameKey(u.selectedCourse) === courseNameKey(course.title)).map(u => u.id)]);
    return send(response, 200, data.users.filter(u => u.role === "learner" && enrolledIds.has(u.id)).map(learner => {
      const modules = Object.values(course.modules || {}).flat(), done = learner.moduleProgress?.[course.id] || {};
      const completed = Object.values(done).reduce((sum, group) => sum + Object.values(group || {}).filter(Boolean).length, 0);
      return { id: learner.id, name: learner.name, email: learner.email, courseId: course.id, courseTitle: course.title, progress: modules.length ? Math.round(completed / modules.length * 100) : 0, completedModules: completed, totalModules: modules.length, submissions: data.submissions.filter(s => s.userId === learner.id && data.assignments.some(a => a.id === s.assignmentId && a.courseId === course.id)).length };
    }));
  }
  if (route === "/api/users/status" && request.method === "POST") {
    if (!requireRole(user, ["admin"])) return send(response, 403, { error: "Forbidden" });
    const body = await readBody(request), account = data.users.find(u => u.id === body.userId);
    if (!account) return send(response, 404, { error: "User not found" });
    const nextStatus = ["Active", "Inactive", "Pending", "Rejected"].includes(String(body.status || "")) ? String(body.status) : (body.active ? "Active" : "Inactive");
    if (account.role === "learner" && account.status === "Pending" && ["Active", "Rejected"].includes(nextStatus)) {
      return send(response, 409, { error: "Pending learner applications must be decided from the admissions review screen" });
    }
    account.status = nextStatus;
    recordActivity(data, user, `${nextStatus === "Active" ? "Approved" : nextStatus === "Rejected" ? "Rejected" : nextStatus === "Pending" ? "Set pending" : "Deactivated"} learner/account ${account.email}`, [account.id]); saveData(data);
    return send(response, 200, publicUser(account));
  }
  if (route === "/api/users/manage" && request.method === "POST") {
    if (!requireRole(user, ["admin"])) return send(response, 403, { error: "Forbidden" });
    const body = await readBody(request);
    if (body.action === "create") {
      const name = String(body.name || "").trim(), email = loginKey(body.email), role = String(body.role || "learner"), password = String(body.password || "");
      if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !["learner", "lecturer", "admin"].includes(role) || password.length < 8) return send(response, 400, { error: "Enter a name, valid email, role, and password of at least 8 characters" });
      if (data.users.some(u => loginKey(u.email) === email)) return send(response, 409, { error: "That email is already registered" });
      const { salt, hash } = hashPassword(password), account = { id: crypto.randomUUID(), name, email, role, avatar: name.split(/\s+/).slice(0, 2).map(p => p[0]).join("").toUpperCase(), status: "Active", passwordSalt: salt, passwordHash: hash };
      data.users.push(account); recordActivity(data, user, `Created ${role} account for ${email}`, [account.id]); saveData(data); return send(response, 201, publicUser(account));
    }
    const account = data.users.find(u => u.id === body.userId);
    if (!account) return send(response, 404, { error: "User not found" });
    if (body.action === "role") {
      if (account.id === user.id) return send(response, 400, { error: "You cannot change your own role" });
      if (!requireRole({ role: body.role }, ["learner", "lecturer", "admin"])) return send(response, 400, { error: "Choose a valid role" });
      const oldRole = account.role; account.role = body.role; recordActivity(data, user, `Changed ${account.email} role from ${oldRole} to ${account.role}`, [account.id]);
    } else if (body.action === "delete") {
      if (account.id === user.id) return send(response, 400, { error: "You cannot delete your own account" });
      data.users = data.users.filter(u => u.id !== account.id); data.enrollments = data.enrollments.filter(e => e.userId !== account.id);
      data.submissions = data.submissions.filter(s => s.userId !== account.id); data.notifications = data.notifications.filter(n => n.userId !== account.id);
      recordActivity(data, user, `Deleted user account ${account.email}`);
    } else return send(response, 400, { error: "Choose create, role, or delete" });
    saveData(data); return send(response, 200, { status: "ok" });
  }
  if (request.method === "PATCH" && route === "/api/me") {
    const body = await readBody(request, 4 * 1024 * 1024);
    const account = data.users.find(item => item.id === user.id);
    const editableFields = ["name", "email", "identityNumber", "passportNumber", "dateOfBirth", "gender", "phone", "lastSchool"];
    for (const [field, legacyField] of [["identityNumber", "legacyIdentityNumber"], ["passportNumber", "legacyPassportNumber"]]) {
      if (!Object.hasOwn(body, field)) continue;
      const nextValue = String(body[field] || "").trim();
      if (normalizeAccountNumber(nextValue) !== normalizeAccountNumber(account[field]) && accountNumberInUse(data.users, field, nextValue, account.id)) {
        return send(response, 409, { error: `That ${field === "identityNumber" ? "identity" : "passport"} number is already registered` });
      }
      if (normalizeAccountNumber(nextValue) !== normalizeAccountNumber(account[field])) delete account[legacyField];
    }
    for (const key of editableFields) {
      if (Object.hasOwn(body, key)) account[key] = String(body[key] || "").trim();
    }
    account.email = account.email.toLowerCase();
    if (!account.name || !account.email) return send(response, 400, { error: "Name and email are required" });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(account.email)) return send(response, 400, { error: "Enter a valid email address" });
    if (data.users.some(item => item.id !== account.id && item.email.toLowerCase() === account.email)) return send(response, 409, { error: "That email address is already in use" });
    if (Object.hasOwn(body, "profileImage")) {
      const image = String(body.profileImage || "");
      if (image && (!/^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+=*$/.test(image) || Buffer.byteLength(image, "utf8") > 2_800_000)) {
        return send(response, 400, { error: "Profile pictures must be PNG, JPG, GIF, or WebP and smaller than 2 MB" });
      }
      account.profileImage = image;
    }
    account.avatar = account.name.trim().split(/\s+/).slice(0, 2).map(part => part[0]).join("").toUpperCase();
    recordActivity(data, account, "Updated profile information");
    saveData(data);
    return send(response, 200, profileUser(account));
  }

  if (request.method === "GET" && route === "/api/courses") {
    let courses = data.courses;
    if (user.role === "learner") {
      const learner = data.users.find(item => item.id === user.id);
      const registeredProgramme = courseNameKey(learner && learner.selectedCourse);
      const registeredCourseIds = new Set(data.enrollments.filter(enrollment => enrollment.userId === user.id).map(enrollment => enrollment.courseId));
      data.courses.forEach(course => {
        if (registeredProgramme && courseNameKey(course.title) === registeredProgramme) registeredCourseIds.add(course.id);
      });
      courses = courses.filter(course => !["pending", "rejected", "archived"].includes(course.status)).map(course => ({ ...course, catalogOnly: !registeredCourseIds.has(course.id) }));
    } else if (user.role === "lecturer") {
      courses = courses.filter(course => course.instructorId === user.id || course.instructor === user.name);
    }
    return send(response, 200, courses);
  }

  if (request.method === "GET" && route === "/api/assignments") {
    let assignments = data.assignments;
    if (user.role === "learner") {
      const learner = data.users.find(item => item.id === user.id);
      const registeredProgramme = courseNameKey(learner && learner.selectedCourse);
      const registeredCourseIds = new Set([
        ...data.courses.filter(course => courseNameKey(course.title) === registeredProgramme).map(course => course.id),
        ...data.enrollments.filter(enrollment => enrollment.userId === user.id).map(enrollment => enrollment.courseId)
      ]);
      const availableCourseIds = new Set(data.courses.filter(course => registeredCourseIds.has(course.id) && !["pending", "rejected", "archived"].includes(course.status)).map(course => course.id));
      assignments = assignments.filter(assignment => availableCourseIds.has(assignment.courseId));
    } else if (user.role === "lecturer") {
      const courseIds = new Set(data.courses.filter(course => course.instructorId === user.id || course.instructor === user.name).map(course => course.id));
      assignments = assignments.filter(assignment => courseIds.has(assignment.courseId));
    }
    const submissions = data.submissions.filter(submission => submission.userId === user.id);
    const visibleAssignments = assignments.map(assignment => {
      const submission = submissions.find(item => item.assignmentId === assignment.id);
      const visible = { ...assignment, status: submission ? "completed" : assignment.status, grade: submission?.score ?? assignment.grade ?? null, feedback: submission?.feedback || "" };
      if (user.role === "learner" && visible.quiz) visible.quiz = { questions: visible.quiz.questions.map(({ prompt, options }) => ({ prompt, options })) };
      return visible;
    });
    return send(response, 200, visibleAssignments);
  }
  if (request.method === "GET" && route === "/api/submissions") {
    if (!requireRole(user, ["lecturer", "admin"])) return send(response, 403, { error: "Forbidden" });
    const courseIds = user.role === "admin" ? null : new Set(data.courses.filter(c => canManageCourse(user, c)).map(c => c.id));
    const rows = data.submissions.filter(s => {
      const assignment = data.assignments.find(a => a.id === s.assignmentId);
      return assignment && (!courseIds || courseIds.has(assignment.courseId));
    }).map(s => {
      const assignment = data.assignments.find(a => a.id === s.assignmentId), learner = data.users.find(u => u.id === s.userId);
      const { fileContent, ...publicSubmission } = s;
      return { ...publicSubmission, studentName: learner?.name || "Learner", assignmentTitle: assignment?.title || "Assessment", courseId: assignment?.courseId };
    });
    return send(response, 200, rows);
  }

  if (request.method === "PATCH" && route === "/api/modules/progress") {
    if (!requireRole(user, ["learner"])) return send(response, 403, { error: "Only learners can update module progress" });
    const body = await readBody(request);
    const course = data.courses.find(item => item.id === String(body.courseId || ""));
    const account = data.users.find(item => item.id === user.id);
    const enrolled = course && (
      data.enrollments.some(enrollment => enrollment.userId === user.id && enrollment.courseId === course.id) ||
      courseNameKey(account && account.selectedCourse) === courseNameKey(course.title)
    );
    if (!enrolled) return send(response, 403, { error: "You are not enrolled in this course" });
    const group = String(body.group || "");
    const index = Number(body.moduleIndex);
    if (!Array.isArray(course.modules && course.modules[group]) || !Number.isInteger(index) || index < 0 || index >= course.modules[group].length || typeof body.completed !== "boolean") {
      return send(response, 400, { error: "Choose a valid programme module" });
    }
    if (!account.moduleProgress || typeof account.moduleProgress !== "object" || Array.isArray(account.moduleProgress)) account.moduleProgress = {};
    if (!account.moduleProgress[course.id] || typeof account.moduleProgress[course.id] !== "object") account.moduleProgress[course.id] = {};
    if (!account.moduleProgress[course.id][group] || typeof account.moduleProgress[course.id][group] !== "object") account.moduleProgress[course.id][group] = {};
    if (body.completed) account.moduleProgress[course.id][group][index] = true;
    else delete account.moduleProgress[course.id][group][index];
    recordActivity(data, account, `${body.completed ? "Completed" : "Reopened"} lesson ${course.modules[group][index]} in ${course.title}`, [course.instructorId]);
    saveData(data);
    return send(response, 200, { moduleProgress: account.moduleProgress });
  }

  if (request.method === "PATCH" && route === "/api/modules/notes") {
    if (!requireRole(user, ["learner"])) return send(response, 403, { error: "Only learners can save module notes" });
    const body = await readBody(request);
    const course = data.courses.find(item => item.id === String(body.courseId || ""));
    const account = data.users.find(item => item.id === user.id);
    const enrolled = course && (
      data.enrollments.some(enrollment => enrollment.userId === user.id && enrollment.courseId === course.id) ||
      courseNameKey(account && account.selectedCourse) === courseNameKey(course.title)
    );
    const group = String(body.group || "");
    const index = Number(body.moduleIndex);
    const note = String(body.note || "");
    if (!enrolled) return send(response, 403, { error: "You are not enrolled in this course" });
    if (!Array.isArray(course.modules && course.modules[group]) || !Number.isInteger(index) || index < 0 || index >= course.modules[group].length) {
      return send(response, 400, { error: "Choose a valid programme module" });
    }
    if (note.length > 5000) return send(response, 400, { error: "Notes must be 5,000 characters or fewer" });
    if (!account.moduleNotes || typeof account.moduleNotes !== "object" || Array.isArray(account.moduleNotes)) account.moduleNotes = {};
    if (!account.moduleNotes[course.id] || typeof account.moduleNotes[course.id] !== "object") account.moduleNotes[course.id] = {};
    if (!account.moduleNotes[course.id][group] || typeof account.moduleNotes[course.id][group] !== "object") account.moduleNotes[course.id][group] = {};
    if (note.trim()) account.moduleNotes[course.id][group][index] = note;
    else delete account.moduleNotes[course.id][group][index];
    saveData(data);
    return send(response, 200, { moduleNotes: account.moduleNotes });
  }

  if (route === "/api/attendance" && request.method === "GET") {
    if (!requireRole(user, ["lecturer", "admin"])) return send(response, 403, { error: "Forbidden" });
    const courseId = url.searchParams.get("courseId") || "";
    const date = url.searchParams.get("date") || "";
    const course = data.courses.find(item => item.id === courseId);
    if (!course || !canManageCourse(user, course)) return send(response, 403, { error: "You cannot manage attendance for this course" });
    if (!isDateKey(date)) {
      return send(response, 400, { error: "Choose a valid attendance date" });
    }
    const enrolledIds = new Set([
      ...data.enrollments.filter(enrollment => enrollment.courseId === courseId).map(enrollment => enrollment.userId),
      ...data.users.filter(learner => learner.role === "learner" && courseNameKey(learner.selectedCourse) === courseNameKey(course.title)).map(learner => learner.id)
    ]);
    const learners = data.users
      .filter(learner => learner.role === "learner" && learner.status !== "Inactive" && enrolledIds.has(learner.id))
      .map(learner => ({ id: learner.id, name: learner.name, email: learner.email }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const records = data.attendance.filter(record => record.courseId === courseId && record.date === date);
    return send(response, 200, { courseId, date, learners, records });
  }

  if (route === "/api/attendance" && request.method === "POST") {
    if (!requireRole(user, ["lecturer", "admin"])) return send(response, 403, { error: "Forbidden" });
    const body = await readBody(request);
    const course = data.courses.find(item => item.id === body.courseId);
    if (!course || !canManageCourse(user, course)) return send(response, 403, { error: "You cannot manage attendance for this course" });
    const date = String(body.date || "");
    if (!isDateKey(date)) {
      return send(response, 400, { error: "Choose a valid attendance date" });
    }
    if (!Array.isArray(body.records)) return send(response, 400, { error: "Attendance records are required" });
    const enrolledIds = new Set([
      ...data.enrollments.filter(enrollment => enrollment.courseId === course.id).map(enrollment => enrollment.userId),
      ...data.users.filter(learner => learner.role === "learner" && courseNameKey(learner.selectedCourse) === courseNameKey(course.title)).map(learner => learner.id)
    ]);
    const validRecords = body.records.filter(record => record && enrolledIds.has(record.userId));
    if (validRecords.length !== body.records.length || new Set(validRecords.map(record => record.userId)).size !== validRecords.length) {
      return send(response, 400, { error: "Attendance includes an invalid or duplicate learner" });
    }
    if (validRecords.some(record => !["present", "absent"].includes(record.status))) {
      return send(response, 400, { error: "Mark every learner present or absent before saving" });
    }
    const learners = data.users
      .filter(learner => learner.role === "learner" && learner.status !== "Inactive" && enrolledIds.has(learner.id))
      .map(learner => ({ id: learner.id, name: learner.name, email: learner.email }))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (validRecords.length !== learners.length) return send(response, 400, { error: "Mark every enrolled learner before saving" });

    data.attendance = data.attendance.filter(record => record.courseId !== course.id || record.date !== date);
    const records = validRecords.map(record => ({
      courseId: course.id,
      date,
      userId: record.userId,
      status: record.status,
      markedBy: user.id,
      markedAt: new Date().toISOString()
    }));
    data.attendance.push(...records);
    recordActivity(data, user, `Recorded attendance for ${course.title} on ${date}`, learners.map(learner => learner.id));
    saveData(data);
    return send(response, 200, { courseId: course.id, date, learners, records });
  }

  if (request.method === "GET" && route === "/api/users") {
    if (!requireRole(user, ["admin"])) return send(response, 403, { error: "Forbidden" });
    return send(response, 200, data.users.map(publicUser));
  }
  if (request.method === "GET" && route === "/api/audit") {
    if (!requireRole(user, ["admin"])) return send(response, 403, { error: "Forbidden" });
    const role = url.searchParams.get("role");
    return send(response, 200, role ? data.audit_log.filter(entry => entry.role === role) : data.audit_log);
  }
  if (request.method === "POST" && route === "/api/audit") {
    if (!requireRole(user, ["admin"])) return send(response, 403, { error: "Forbidden" });
    const body = await readBody(request);
    const action = String(body.action || "").trim().slice(0, 180);
    if (!action) return send(response, 400, { error: "An audit action is required" });
    const entry = {
      id: crypto.randomUUID(),
      time: new Date().toISOString(),
      user: user.email,
      role: user.role,
      action,
      status: "Success"
    };
    if (!Array.isArray(data.audit_log)) data.audit_log = [];
    data.audit_log.unshift(entry);
    data.audit_log = data.audit_log.slice(0, 5000);
    saveData(data);
    return send(response, 201, entry);
  }
  if (request.method === "GET" && route === "/api/stats") {
    if (user.role === "learner") {
      const learner = data.users.find(item => item.id === user.id);
      const registeredProgramme = courseNameKey(learner && learner.selectedCourse);
      const courseIds = new Set(data.courses.filter(course => courseNameKey(course.title) === registeredProgramme).map(course => course.id));
      return send(response, 200, {
        courses: courseIds.size,
        assignments: data.assignments.filter(item => courseIds.has(item.courseId)).length,
        submissions: data.submissions.filter(item => item.userId === user.id).length
      });
    }
    return send(response, 200, {
      users: data.users.length,
      courses: data.courses.length,
      assignments: data.assignments.length,
      submissions: data.submissions.length
    });
  }

  if (request.method === "POST" && route === "/api/submissions") {
    if (!requireRole(user, ["learner"])) return send(response, 403, { error: "Forbidden" });
    const body = await readBody(request, 8 * 1024 * 1024);
    const assignment = data.assignments.find(item => item.id === body.assignmentId);
    if (!assignment) return send(response, 404, { error: "Assignment not found" });
    const learner = data.users.find(item => item.id === user.id);
    const registeredProgramme = courseNameKey(learner && learner.selectedCourse);
    const enrolled = data.enrollments.some(enrollment => enrollment.userId === user.id && enrollment.courseId === assignment.courseId) || data.courses.some(course => course.id === assignment.courseId && courseNameKey(course.title) === registeredProgramme);
    if (!enrolled) return send(response, 403, { error: "You are not enrolled in this course" });
    if (data.submissions.some(item => item.userId === user.id && item.assignmentId === assignment.id)) {
      return send(response, 409, { error: "You have already submitted this assessment" });
    }
    const filename = String(body.filename || "").trim();
    const fileContent = String(body.fileContent || "");
    if (!filename || !/^[A-Za-z0-9+/]*={0,2}$/.test(fileContent) || !fileContent) {
      return send(response, 400, { error: "Choose a file to submit" });
    }
    const fileBuffer = Buffer.from(fileContent, "base64");
    if (fileBuffer.length > 5 * 1024 * 1024 || fileBuffer.toString("base64") !== fileContent) {
      return send(response, 413, { error: "Submission files must be smaller than 5 MB" });
    }
    const submission = {
      id: crypto.randomUUID(),
      userId: user.id,
      assignmentId: assignment.id,
      comments: String(body.comments || ""),
      filename: path.basename(filename).slice(0, 255),
      fileType: String(body.fileType || "application/octet-stream").slice(0, 120),
      fileSize: fileBuffer.length,
      fileContent,
      submittedAt: new Date().toISOString()
    };
    data.submissions.push(submission);
    const course = data.courses.find(c => c.id === assignment.courseId);
    const lecturer = data.users.find(u => u.id === course?.instructorId);
    recordActivity(data, user, `Submitted ${assignment.title}`, [lecturer?.id]);
    saveData(data);
    const publicSubmission = { ...submission };
    delete publicSubmission.fileContent;
    return send(response, 201, publicSubmission);
  }

  if (request.method === "POST" && route === "/api/assignments") {
    if (!requireRole(user, ["lecturer", "admin"])) return send(response, 403, { error: "Forbidden" });
    const body = await readBody(request);
    const course = data.courses.find(item => item.code === body.course || item.id === body.course);
    if (!course) return send(response, 400, { error: "Choose a valid course" });
    if (user.role === "lecturer" && !canManageCourse(user, course)) return send(response, 403, { error: "You cannot publish assessments for this course" });
    const type = String(body.type || "Assignment");
    if (type === "Quiz" && (!Array.isArray(body.quiz?.questions) || !body.quiz.questions.length || body.quiz.questions.some(q => !String(q.prompt || "").trim() || !Array.isArray(q.options) || q.options.length < 2 || !Number.isInteger(Number(q.answer)) || Number(q.answer) < 0 || Number(q.answer) >= q.options.length))) return send(response, 400, { error: "Add quiz questions, options, and a valid correct answer for each question" });
    const assignment = { id: crypto.randomUUID(), title: String(body.title || "").trim(), course: course.code, courseId: course.id, due: body.due || "", status: "pending", grade: null, type, ...(type === "Quiz" ? { quiz: body.quiz } : {}), createdBy: user.id };
    if (!assignment.title) return send(response, 400, { error: "Assignment title is required" });
    data.assignments.push(assignment);
    const learners = data.users.filter(u => u.role === "learner" && u.status !== "Inactive" && (u.selectedCourse && courseNameKey(u.selectedCourse) === courseNameKey(course.title) || data.enrollments.some(e => e.userId === u.id && e.courseId === course.id)));
    recordActivity(data, user, `Published assessment ${assignment.title}`, learners.map(u => u.id));
    saveData(data);
    return send(response, 201, assignment);
  }

  if (request.method === "GET" && route === "/api/materials") {
    if (!requireRole(user, ["learner", "lecturer", "admin"])) return send(response, 403, { error: "Forbidden" });
    let courseIds = new Set(data.courses.map(course => course.id));
    if (user.role === "lecturer") {
      courseIds = new Set(data.courses.filter(course => canManageCourse(user, course)).map(course => course.id));
    } else if (user.role === "learner") {
      const learner = data.users.find(item => item.id === user.id);
      const registeredProgramme = courseNameKey(learner && learner.selectedCourse);
      const enrolledCourseIds = new Set(data.enrollments.filter(enrollment => enrollment.userId === user.id).map(enrollment => enrollment.courseId));
      courseIds = new Set(data.courses.filter(course =>
        !["pending", "rejected", "archived"].includes(course.status) &&
        (enrolledCourseIds.has(course.id) || courseNameKey(course.title) === registeredProgramme)
      ).map(course => course.id));
    }
    // Older uploads stored only the course code (or title), before material
    // records included courseId. Resolve those records at read time so they
    // remain visible without rewriting the existing JSON data.
    const accessibleCourses = data.courses.filter(course => courseIds.has(course.id));
    const materials = data.materials.flatMap(material => {
      const course = accessibleCourses.find(item => item.id === material.courseId ||
        (material.course && (String(material.course).toLowerCase() === String(item.code || "").toLowerCase() ||
          String(material.course).toLowerCase() === String(item.title || "").toLowerCase())));
      return course ? [{ ...material, courseId: course.id }] : [];
    });
    return send(response, 200, materials);
  }

  if (request.method === "POST" && route === "/api/materials") {
    if (!requireRole(user, ["lecturer", "admin"])) return send(response, 403, { error: "Forbidden" });
    const body = await readBody(request, 8 * 1024 * 1024);
    const course = data.courses.find(item => item.id === String(body.courseId || ""));
    if (!course || !canManageCourse(user, course)) return send(response, 403, { error: "You cannot upload content to this course" });
    const group = String(body.group || "");
    const moduleIndex = Number(body.moduleIndex);
    if (!Array.isArray(course.modules?.[group]) || !Number.isInteger(moduleIndex) || moduleIndex < 0 || moduleIndex >= course.modules[group].length) {
      return send(response, 400, { error: "Choose a valid course topic" });
    }
    const title = String(body.title || "").trim().slice(0, 180);
    const filename = path.basename(String(body.filename || "").trim()).slice(0, 255);
    const fileContent = String(body.fileContent || "");
    const fileType = String(body.fileType || "application/octet-stream");
    if (!title) return send(response, 400, { error: "Content title is required" });
    if (!filename || !/^[A-Za-z0-9+/]*={0,2}$/.test(fileContent) || !fileContent) return send(response, 400, { error: "Choose a file to upload" });
    const fileBuffer = Buffer.from(fileContent, "base64");
    if (fileBuffer.length > 5 * 1024 * 1024 || fileBuffer.toString("base64") !== fileContent) {
      return send(response, 413, { error: "Learning content files must be 5 MB or smaller" });
    }
    if (!/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(fileType)) {
      return send(response, 400, { error: "Choose a valid file type" });
    }
    const material = {
      id: crypto.randomUUID(),
      courseId: course.id,
      course: course.code,
      group,
      moduleIndex,
      title,
      filename,
      fileType,
      fileSize: fileBuffer.length,
      fileContent,
      uploadedBy: user.id,
      uploadedAt: new Date().toISOString()
    };
    data.materials.push(material);
    const learners = course ? data.users.filter(item => item.role === "learner" && item.status !== "Inactive" && (courseNameKey(item.selectedCourse) === courseNameKey(course.title) || data.enrollments.some(e => e.userId === item.id && e.courseId === course.id))).map(item => item.id) : [];
    const uploadMessage = `Uploaded ${material.title} to ${course.modules[group][moduleIndex]} in ${course.title}`;
    recordActivity(data, user, uploadMessage, learners);
    // Keep a notification in the lecturer's own portal as well, so the upload is visible in their notification centre.
    notify(data, user.id, "Upload published", `${material.title} was uploaded successfully to ${course.title}.`);
    saveData(data);
    return send(response, 201, material);
  }

  if (request.method === "POST" && route === "/api/submissions/grade") {
    if (!requireRole(user, ["lecturer", "admin"])) return send(response, 403, { error: "Forbidden" });
    const body = await readBody(request);
    const submission = data.submissions.find(item => item.assignmentId === body.assignment && item.userId === body.student) || null;
    const assignment = data.assignments.find(item => item.id === body.assignment);
    const course = assignment && data.courses.find(item => item.id === assignment.courseId);
    if (!submission || !course || !canManageCourse(user, course)) return send(response, 404, { error: "Submission not found or unavailable" });
    if (!Number.isFinite(Number(body.score)) || Number(body.score) < 0 || Number(body.score) > 100) return send(response, 400, { error: "Score must be between 0 and 100" });
    {
      submission.score = Number(body.score);
      submission.feedback = String(body.feedback || "");
      submission.gradedAt = new Date().toISOString();
      const grader = data.users.find(u => u.id === submission.userId);
      recordActivity(data, user, `Graded ${body.assignment} for ${grader?.name || "learner"}: ${submission.score}%`, [submission.userId]);
      saveData(data);
    }
    return send(response, 200, { status: "recorded" });
  }

  return send(response, 404, { error: "Not found" });
}

const server = http.createServer((request, response) => {
  handle(request, response).catch(error => {
    console.error(error);
    if (!response.headersSent) send(response, error.status || 500, { error: error.status ? error.message : "Internal server error" });
    else response.end();
  });
});

async function startServer() {
  try {
    if (SUPABASE_SECRET_KEY.startsWith("sb_publishable_")) {
      throw new Error("SUPABASE_SECRET_KEY contains a publishable key. Set the server-side sb_secret_ key from Supabase Settings > API Keys.");
    }
    if (Boolean(SUPABASE_URL) !== Boolean(SUPABASE_API_KEY)) {
      throw new Error("Set both SUPABASE_URL and SUPABASE_SECRET_KEY (or legacy SUPABASE_SERVICE_ROLE_KEY), or leave both unset to use data.json");
    }
    if (supabaseConfigured) await initializeSupabaseState();
    else loadData();
  } catch (error) {
    // Keep local development usable when Supabase is temporarily unreachable.
    // Configuration/schema errors still stop startup so they are not masked.
    if (supabaseConfigured && /^Unable to reach Supabase:/.test(error.message)) {
      supabaseConfigured = false;
      loadData();
      console.warn("Supabase is unreachable; using backend/data.json for this session.");
    } else {
      console.error("Could not initialize LMS persistence:", error.message);
      process.exitCode = 1;
      return;
    }
  }
  server.listen(PORT, HOST, () => console.log(`Chimera LMS JavaScript API listening on http://${HOST}:${PORT}`));
}

startServer();

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
