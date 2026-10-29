import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";

const backendDirectory = path.dirname(fileURLToPath(import.meta.url));
const serverFile = path.join(backendDirectory, "server.js");
let temporaryDirectory;
let stateFile;
let serverPort;
let serverProcess;
let serverOutput = "";

async function findAvailablePort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => listener.once("error", reject).listen(0, "127.0.0.1", resolve));
  const { port } = listener.address();
  await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  return port;
}

async function startServer() {
  serverProcess = spawn(process.execPath, [serverFile], {
    cwd: backendDirectory,
    env: {
      ...process.env,
      PORT: String(serverPort),
      HOST: "127.0.0.1",
      JWT_SECRET: "isolated-workflow-test-secret",
      CHIMERA_DATA_FILE: stateFile,
      SUPABASE_URL: "",
      SUPABASE_SECRET_KEY: "",
      SUPABASE_SERVICE_ROLE_KEY: ""
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  serverProcess.stdout.on("data", chunk => { serverOutput += chunk.toString(); });
  serverProcess.stderr.on("data", chunk => { serverOutput += chunk.toString(); });
  const origin = `http://127.0.0.1:${serverPort}`;
  for (let attempt = 0; attempt < 60; attempt++) {
    if (serverProcess.exitCode !== null) throw new Error(`Test server exited early:\n${serverOutput}`);
    try {
      const response = await fetch(`${origin}/api/health`);
      if (response.ok) return origin;
    } catch { /* The listener may not be ready yet. */ }
    await delay(100);
  }
  throw new Error(`Test server did not start:\n${serverOutput}`);
}

async function stopServer() {
  if (!serverProcess || serverProcess.exitCode !== null) return;
  const processToStop = serverProcess;
  processToStop.kill();
  await Promise.race([once(processToStop, "exit"), delay(3000)]);
  serverProcess = null;
}

async function request(origin, route, { method = "GET", body, token } = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${origin}${route}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const contentType = response.headers.get("content-type") || "";
  return {
    response,
    data: contentType.includes("application/json") ? await response.json() : null,
    bytes: contentType.includes("application/json") ? null : Buffer.from(await response.arrayBuffer())
  };
}

function makeValidSouthAfricanId(sequence) {
  const prefix = `8001015009${String(sequence).padStart(2, "0")}`;
  let total = 0;
  for (let index = 0; index < prefix.length; index++) {
    let digit = Number(prefix[index]);
    if (index % 2 === 0) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    total += digit;
  }
  return `${prefix}${(10 - total % 10) % 10}`;
}

function makeRegistration(sequence, documents = true) {
  const identity = Buffer.from("%PDF-1.4\nSynthetic identity test\n%%EOF", "ascii").toString("base64");
  const qualification = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]).toString("base64");
  return {
    firstName: "Test",
    surname: `Learner${sequence}`,
    name: `Test Learner${sequence}`,
    username: `workflow-test-${sequence}`,
    email: `workflow-test-${sequence}@example.invalid`,
    emailConfirm: `workflow-test-${sequence}@example.invalid`,
    password: "Test-password-2026",
    passwordConfirm: "Test-password-2026",
    identityNumber: makeValidSouthAfricanId(sequence),
    passportNumber: "",
    dateOfBirth: "1980-01-01",
    gender: "prefer-not-to-say",
    phone: "+27123456789",
    lastSchool: "Synthetic Test School",
    highestQualification: "Matric / National Senior Certificate",
    recoveryQuestion: "What was the name of your first school?",
    recoveryAnswer: "Synthetic answer",
    course: "Data Science Practitioner",
    agreement: true,
    documents: documents ? [
      { kind: "identity", filename: "synthetic-id.pdf", fileType: "application/pdf", contentBase64: identity },
      { kind: "qualification", filename: "synthetic-results.png", fileType: "image/png", contentBase64: qualification }
    ] : []
  };
}

before(async () => {
  temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "chimera-workflow-test-"));
  stateFile = path.join(temporaryDirectory, "isolated-state.json");
  serverPort = await findAvailablePort();
});

after(async () => {
  await stopServer();
  if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true });
});

test("registration, tracking, admin review, decision, notifications, and restart persistence", async () => {
  let origin = await startServer();
  const missingDocuments = await request(origin, "/api/auth/register", { method: "POST", body: makeRegistration(11, false) });
  assert.equal(missingDocuments.response.status, 400);
  assert.match(missingDocuments.data.error, /identity document/i);

  const invalidFile = makeRegistration(12);
  invalidFile.documents[0] = { kind: "identity", filename: "identity.txt", fileType: "text/plain", contentBase64: Buffer.from("not a document").toString("base64") };
  const invalidDocument = await request(origin, "/api/auth/register", { method: "POST", body: invalidFile });
  assert.equal(invalidDocument.response.status, 400);

  const applicant = makeRegistration(13);
  const submitted = await request(origin, "/api/auth/register", { method: "POST", body: applicant });
  assert.equal(submitted.response.status, 201);
  assert.equal(submitted.data.pendingApproval, true);
  assert.match(submitted.data.applicationReference, /^CHM-\d{4}-[A-F0-9]{8}$/);

  let persisted = JSON.parse(readFileSync(stateFile, "utf8"));
  const learner = persisted.users.find(user => user.email === applicant.email);
  const application = persisted.program_applications.find(item => item.userId === learner.id);
  assert.equal(learner.status, "Pending");
  assert.notEqual(learner.passwordHash, applicant.password);
  assert.equal(persisted.enrollments.some(enrollment => enrollment.userId === learner.id), false);
  assert.equal(application.documents.length, 2);

  const duplicate = await request(origin, "/api/auth/register", { method: "POST", body: applicant });
  assert.equal(duplicate.response.status, 409);
  const pendingLogin = await request(origin, "/api/auth/login", { method: "POST", body: { username: applicant.email, password: applicant.password, role: "learner" } });
  assert.equal(pendingLogin.response.status, 403);
  const wrongTrackPassword = await request(origin, "/api/auth/track", { method: "POST", body: { identifier: submitted.data.applicationReference, password: "incorrect" } });
  assert.equal(wrongTrackPassword.response.status, 401);
  const tracked = await request(origin, "/api/auth/track", { method: "POST", body: { identifier: submitted.data.applicationReference, password: applicant.password } });
  assert.equal(tracked.response.status, 200);
  assert.equal(tracked.data.application.status, "Pending Admin Approval");
  assert.equal(tracked.data.application.referenceNumber, submitted.data.applicationReference);
  assert.equal(Object.hasOwn(tracked.data.application, "email"), false);

  const adminLogin = await request(origin, "/api/auth/login", { method: "POST", body: { username: "m.rivera@admin.edu", password: "demo", role: "admin" } });
  assert.equal(adminLogin.response.status, 200);
  const adminToken = adminLogin.data.token;
  const lecturerLogin = await request(origin, "/api/auth/login", { method: "POST", body: { username: "s.chen@faculty.edu", password: "demo", role: "lecturer" } });
  assert.equal(lecturerLogin.response.status, 200);
  const forbiddenList = await request(origin, "/api/admin/applications", { token: lecturerLogin.data.token });
  assert.equal(forbiddenList.response.status, 403);
  const listed = await request(origin, "/api/admin/applications", { token: adminToken });
  assert.equal(listed.response.status, 200);
  assert.ok(listed.data.some(item => item.id === application.id && item.documentCount === 2));
  const detail = await request(origin, `/api/admin/applications/${application.id}`, { token: adminToken });
  assert.equal(detail.response.status, 200);
  assert.equal(Object.hasOwn(detail.data.application.documents[0], "contentBase64"), false);
  const forbiddenDocument = await request(origin, `/api/admin/applications/${application.id}/documents/${application.documents[0].id}`, { token: lecturerLogin.data.token });
  assert.equal(forbiddenDocument.response.status, 403);
  const document = await request(origin, `/api/admin/applications/${application.id}/documents/${application.documents[0].id}`, { token: adminToken });
  assert.equal(document.response.status, 200);
  assert.equal(document.bytes.subarray(0, 5).toString("ascii"), "%PDF-");

  const approval = await request(origin, `/api/admin/applications/${application.id}/decision`, {
    method: "POST",
    token: adminToken,
    body: { decision: "approved", feedback: "" }
  });
  assert.equal(approval.response.status, 200);
  assert.equal(approval.data.notifications.inApp, "sent");
  assert.equal(approval.data.notifications.email, "not_configured");
  const duplicateApproval = await request(origin, `/api/admin/applications/${application.id}/decision`, { method: "POST", token: adminToken, body: { decision: "approved" } });
  assert.equal(duplicateApproval.response.status, 409);
  persisted = JSON.parse(readFileSync(stateFile, "utf8"));
  assert.equal(persisted.enrollments.filter(enrollment => enrollment.userId === learner.id).length, 1);
  assert.equal(persisted.notifications.filter(notification => notification.userId === learner.id && notification.type === "application").length, 1);

  const approvedLogin = await request(origin, "/api/auth/login", { method: "POST", body: { username: applicant.email, password: applicant.password, role: "learner" } });
  assert.equal(approvedLogin.response.status, 200);
  const approvedCourses = await request(origin, "/api/courses", { token: approvedLogin.data.token });
  assert.equal(approvedCourses.response.status, 200);
  assert.ok(approvedCourses.data.some(course => course.title === applicant.course && course.catalogOnly === false));
  const notifications = await request(origin, "/api/notifications", { token: approvedLogin.data.token });
  assert.ok(notifications.data.some(notification => notification.title === "Enrolment application approved"));

  const rejectedApplicant = makeRegistration(14);
  const rejectedSubmission = await request(origin, "/api/auth/register", { method: "POST", body: rejectedApplicant });
  assert.equal(rejectedSubmission.response.status, 201);
  const applications = await request(origin, "/api/admin/applications", { token: adminToken });
  const rejectedApplication = applications.data.find(item => item.referenceNumber === rejectedSubmission.data.applicationReference);
  const rejection = await request(origin, `/api/admin/applications/${rejectedApplication.id}/decision`, { method: "POST", token: adminToken, body: { decision: "rejected", feedback: "The supplied documents do not meet the programme requirements." } });
  assert.equal(rejection.response.status, 200);
  const rejectedLogin = await request(origin, "/api/auth/login", { method: "POST", body: { username: rejectedApplicant.email, password: rejectedApplicant.password, role: "learner" } });
  assert.equal(rejectedLogin.response.status, 403);
  const rejectedStatus = await request(origin, "/api/auth/track", { method: "POST", body: { identifier: rejectedSubmission.data.applicationReference, password: rejectedApplicant.password } });
  assert.equal(rejectedStatus.data.application.status, "Rejected");
  assert.match(rejectedStatus.data.application.reviewNote, /documents do not meet/);

  await stopServer();
  origin = await startServer();
  const persistedStatus = await request(origin, "/api/auth/track", { method: "POST", body: { identifier: submitted.data.applicationReference, password: applicant.password } });
  assert.equal(persistedStatus.data.application.status, "Approved");
  const persistedApplications = await request(origin, "/api/admin/applications", { token: adminToken });
  assert.equal(persistedApplications.response.status, 200);
  assert.equal(serverOutput.includes("Error"), false, serverOutput);
});