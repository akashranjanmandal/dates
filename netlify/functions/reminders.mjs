// Scheduled function: every 5 minutes, deliver the reminders that just came due.
// The logic lives in ../shared/jobs.mjs so the local dev server can run it too.
import { runReminders } from "../shared/jobs.mjs";

export default async () => {
  await runReminders();
};

export const config = { schedule: "*/5 * * * *" };
