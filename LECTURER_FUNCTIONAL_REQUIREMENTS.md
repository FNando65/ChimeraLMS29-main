# Lecturer Portal Functional Requirements

## 1. Purpose and scope

This document defines the functional requirements for the lecturer portal shown in the supplied reference images. It covers course management, learning content, students, assessments, communication, analytics, scheduling, and lecturer administration.

The requirements apply to authenticated users with the `lecturer` role. A lecturer may access only courses assigned to that lecturer, except where an administrator is explicitly permitted to act on behalf of lecturers.

The current backend reference is [`backend/server.js`](./backend/server.js).

## 2. Actors

| Actor | Responsibility |
|---|---|
| Lecturer | Manages assigned courses, content, students, assessments, communication, and reports. |
| Learner | Consumes course content, attends sessions, submits work, views feedback, and communicates with the lecturer. |
| Administrator/HOD | Approves or archives courses, reassigns lecturers, manages users, and receives lecturer reports. |
| External service | Optional provider for video meetings, plagiarism checking, push notifications, and email. |

## 3. General business rules

1. A lecturer must be authenticated before accessing lecturer functions.
2. A lecturer may view or modify only courses where the lecturer is the assigned instructor.
3. Inactive learners must not be included in active rosters or new attendance records.
4. Every material, assessment, grade, attendance record, announcement, and approval must retain its creator, course, and timestamp.
5. User-facing validation errors must explain what is required and must not partially save a failed operation.
6. Actions that affect learners should create an in-app notification and an auditable activity entry where applicable.
7. Destructive actions must require confirmation and must preserve an audit trail. Where feasible, archive rather than permanently delete.

## 4. Functional requirements

### FR-L-001: My courses and teaching load

The system shall:

- Display all courses assigned to the authenticated lecturer for the current teaching period.
- Display each course code, title, enrolment count, course status, and learner/module progress summary.
- Provide quick actions to open/manage a course, edit course information where permitted, and archive a course where permitted.
- Allow the lecturer to upload or replace a syllabus and course outline in an approved file format.
- Prevent the lecturer from viewing or changing another lecturer's course.
- Show pending, active, rejected, and archived course states with clear labels.

### FR-L-002: Course content management

The system shall:

- Allow the lecturer to create a course structure using weeks, units, topics, or equivalent groups.
- Allow upload of videos, PDFs, slide decks, documents, and links against a selected topic.
- Validate file name, file type, file size, and required title before saving.
- Allow the lecturer to edit, replace, reorder, hide, or remove learning resources.
- Allow a resource release date/time to be configured.
- Allow a resource to be visible immediately, hidden, or scheduled for release.
- Notify enrolled learners when new content is published, subject to notification preferences.
- Allow the lecturer to create a live lecture entry with date/time, meeting provider, join link, and optional recording link.
- Provide an option to open a Zoom/Google Meet link and record attendance for the live session.

### FR-L-003: Student management

The system shall:

- Display a roster of all active learners enrolled in a lecturer's course.
- Display learner name, profile photo/avatar, student number where available, email, enrolment status, and progress.
- Support search and filtering by name, student number, year/cohort, attendance, progress, performance, and risk status.
- Allow the lecturer to record attendance as present, absent, or late for a selected course session/date.
- Allow the lecturer to review and correct attendance while retaining who changed it and when.
- Display an individual learner profile containing submissions, marks, feedback, attendance, progress, and activity history.
- Allow a lecturer to flag or unflag a learner as at risk, with a reason and timestamp.
- Notify the lecturer when a learner meets configured risk thresholds, if risk automation is enabled.

### FR-L-004: Assessments and grading

The system shall:

- Allow the lecturer to create assignments, quizzes, tests, and examinations for an assigned course.
- Capture title, instructions, availability, due date/time, total marks, attempt limit, permitted file types, and late-submission policy.
- Support automatically marked multiple-choice questions and manually marked written responses.
- Allow the lecturer to configure quiz questions, options, correct answers, marks, and feedback.
- Display all submissions for a course, including learner, submission date, attempt, file/download access, status, mark, and feedback.
- Allow manual grading with a score between zero and the configured maximum and written feedback.
- Release or withhold marks and feedback from learners according to the lecturer's selection.
- Allow a lecturer to approve or reject a learner re-submission or extension request, with a reason and revised due date where approved.
- Calculate grades according to the course grading scheme and show an auditable grade history.
- Export a gradebook containing learners, assessment marks, totals, weighting, and final grades to Excel-compatible format.
- Support plagiarism-check results and links when an approved plagiarism service is configured.

### FR-L-005: Communication

The system shall:

- Allow a lecturer to create announcements for all learners, one course, or one learner.
- Allow a lecturer to send and receive course messages with enrolled learners.
- Provide an inbox with unread/read state, timestamps, sender, recipient, course, and message history.
- Provide course discussion/Q&A moderation, including replying, hiding/removing inappropriate posts where authorized, and marking a question as answered.
- Send in-app notifications for relevant announcements, messages, published content, assessment changes, grades, and approved extensions.
- Support push or email delivery when the corresponding external notification service is configured.

### FR-L-006: Analytics dashboard

The system shall provide a lecturer dashboard with course and date filters and, at minimum, the following indicators:

- Course completion: percentage of learners who completed the selected module/course content.
- Student engagement: learners who have not logged in or interacted within a configurable number of days, default seven.
- Average performance: class average for a selected assessment or course assessment set.
- Submission rate: submitted learners versus expected learners for a selected assessment, for example `25/40`.
- Attendance rate and at-risk learner count.
- Trends over time for completion, engagement, performance, submissions, and attendance.
- Drill-down from each metric to the affected learner list and relevant course activity.
- Export of filtered analytics for lecturer or HOD reporting.

### FR-L-007: Schedule and calendar

The system shall:

- Display a timetable/calendar view for lectures, live sessions, assessment deadlines, marking due dates, office hours, and reminders.
- Allow the lecturer to create, edit, and cancel lecture and office-hour events.
- Allow the lecturer to define recurring office hours and available booking slots.
- Allow learners to request/book an available office-hour slot and prevent double booking.
- Send configurable reminders before lectures, deadlines, marking due dates, and appointments.
- Display events in the lecturer's local time zone and store timestamps consistently.

### FR-L-008: Lecturer administration and settings

The system shall:

- Allow the lecturer to view and update their profile, contact details, profile image, and qualifications.
- Allow the lecturer to configure a course grading scheme, including assessment names, weights, pass mark, and rounding rules.
- Validate that grading weights total 100% before activation.
- Allow the lecturer to download course, attendance, assessment, gradebook, and analytics reports.
- Allow an HOD/administrator to access reports explicitly shared or permitted by role.
- Provide help/support access and a secure logout function.
- Record material account and grading-setting changes in the audit log.

## 5. Backend capability mapping

The following capabilities are already represented in [`backend/server.js`](./backend/server.js):

| Image capability | Current backend support |
|---|---|
| Assigned courses | `GET /api/courses` filters lecturer courses. |
| Course/module structure | `POST /api/lessons` and `POST /api/lessons/delete`. |
| Learning-material upload | `GET/POST /api/materials`, including base64 file validation and a 5 MB limit. |
| Assessments | `GET/POST /api/assignments` and `POST /api/assignments/delete`. |
| Quiz auto-marking | `POST /api/quiz/submit`. |
| Submission review/grading | `GET /api/submissions`, `POST /api/submissions/grade`. |
| Announcements | `GET/POST /api/announcements`. |
| Lecturer-learner messaging | `GET/POST /api/messages`. |
| Learner progress | `GET /api/progress`. |
| Attendance | `GET/POST /api/attendance`, currently present/absent. |
| Notifications | `GET /api/notifications` and `POST /api/notifications/read`. |
| Lecturer course access control | `canManageCourse(...)` is applied to lecturer course operations. |

## 6. Identified backend gaps

The following requirements from the images are not fully represented by the current routes and should be treated as implementation backlog:

- Course edit/archive action for lecturers and syllabus/course-outline storage.
- Material edit, reorder, hide/show, release-date, and link-resource support.
- Live lecture/session records, meeting links, recordings, and automatic session attendance.
- Late attendance status; the current attendance route accepts only `present` and `absent`.
- Student number, year/cohort, performance filters, learner risk flags, and profile activity views.
- Assessment attempt limits, marking schemes, feedback release, re-submission/extension workflow, and gradebook export.
- Plagiarism-check integration.
- Discussion forum/Q&A moderation and push notifications.
- Dedicated analytics aggregation and drill-down endpoints.
- Calendar events, office-hour bookings, and reminders.
- Lecturer qualifications, course grading-scheme configuration, and HOD report export.

## 7. Non-functional acceptance criteria

- All lecturer endpoints return `401` for unauthenticated requests and `403` for unauthorized course access.
- A lecturer cannot access another lecturer's courses, learners, submissions, attendance, materials, or analytics by changing an ID in the request.
- Saved records remain available after server restart and retain their identifiers and timestamps.
- Failed validation does not create partial course, content, assessment, grade, or attendance records.
- File uploads enforce configured type and size limits and do not expose private file content to unauthorized users.
- Dashboard metrics use the same source records as course, attendance, assessment, and submission views.
- Every release, grading, attendance correction, extension decision, archive, and risk flag is auditable.

## 8. Acceptance summary

The lecturer portal is functionally complete for a first release when a lecturer can manage an assigned course from creation through delivery, monitor learners, assess and grade work, communicate with the class, review actionable analytics, manage teaching events, and download compliant reports, while all lecturer data remains isolated by course ownership and role permissions.
