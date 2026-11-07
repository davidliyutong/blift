import { Hono } from "hono";
import { requireUser } from "../auth";
import { all, now, one, run, stmt } from "../db";
import type { AppEnv } from "../env";
import { badRequest, conflict, forbidden, notConfigured, notFound } from "../lib/errors";
import { body, oneOf, projectName, str } from "../lib/http";
import { newId } from "../lib/ids";
import { deleteProjectStmts, loadProject, PROJECT_SELECT, toProject, type ProjectRow } from "../services/projects";

const r = new Hono<AppEnv>();

const nameTaken = () => conflict("name_taken", "you already have a project with this name");

r.get("/", async (c) => {
  const u = requireUser(c);
  const rows = await all<ProjectRow>(
    c.env.DB,
    `${PROJECT_SELECT} WHERE m.role IS NOT NULL AND p.status = 'active' ORDER BY p.updated_at DESC`,
    u.id,
  );
  return c.json({ projects: rows.map(toProject) });
});

r.post("/", async (c) => {
  const u = requireUser(c);
  const b = await body(c);
  const name = projectName(b.name);
  const description = typeof b.description === "string" ? b.description.trim().slice(0, 1000) : "";
  const storage = b.storage_id
    ? await one<{ id: string }>(c.env.DB, "SELECT id FROM storages WHERE id = ?", b.storage_id)
    : await one<{ id: string }>(c.env.DB, "SELECT id FROM storages ORDER BY is_default DESC, created_at LIMIT 1");
  if (!storage) throw b.storage_id ? notFound("storage") : notConfigured("no storage backend configured yet; ask an admin");
  if (await one(c.env.DB, "SELECT 1 AS x FROM projects WHERE owner_id = ? AND name = ? COLLATE NOCASE AND status = 'active'", u.id, name))
    throw nameTaken();

  const id = newId();
  const t = now();
  await c.env.DB.batch([
    stmt(
      c.env.DB,
      "INSERT INTO projects (id, name, description, owner_id, storage_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      id,
      name,
      description,
      u.id,
      storage.id,
      t,
      t,
    ),
    stmt(c.env.DB, "INSERT INTO project_members (project_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)", id, u.id, t),
  ]);
  return c.json(toProject(await loadProject(c, id, "viewer")), 201);
});

r.get("/:id", async (c) => c.json(toProject(await loadProject(c, c.req.param("id"), "viewer"))));

r.patch("/:id", async (c) => {
  const p = await loadProject(c, c.req.param("id"), "owner");
  const b = await body(c);
  const name = b.name === undefined ? p.name : projectName(b.name);
  const description = typeof b.description === "string" ? b.description.trim().slice(0, 1000) : p.description;
  if (
    name.toLowerCase() !== p.name.toLowerCase() &&
    (await one(c.env.DB, "SELECT 1 AS x FROM projects WHERE owner_id = ? AND name = ? COLLATE NOCASE AND status = 'active'", p.owner_id, name))
  )
    throw nameTaken();
  await run(c.env.DB, "UPDATE projects SET name = ?, description = ?, updated_at = ? WHERE id = ?", name, description, now(), p.id);
  return c.json(toProject(await loadProject(c, p.id, "viewer")));
});

r.delete("/:id", async (c) => {
  const p = await loadProject(c, c.req.param("id"), "owner");
  await c.env.DB.batch(deleteProjectStmts(c.env.DB, p));
  return c.body(null, 204);
});

// ---- Members

type MemberRow = { id: string; username: string; display_name: string | null; email: string | null; role: string; created_at: number };

const toMember = (m: MemberRow) => ({
  user: { id: m.id, username: m.username, display_name: m.display_name, email: m.email },
  role: m.role,
  created_at: m.created_at,
});

const MEMBER_SELECT = `
  SELECT u.id, u.username, u.display_name, u.email, m.role, m.created_at
  FROM project_members m JOIN users u ON u.id = m.user_id`;

r.get("/:id/members", async (c) => {
  const p = await loadProject(c, c.req.param("id"), "viewer");
  const rows = await all<MemberRow>(
    c.env.DB,
    `${MEMBER_SELECT} WHERE m.project_id = ?
     ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'editor' THEN 1 ELSE 2 END, u.username`,
    p.id,
  );
  return c.json({ members: rows.map(toMember) });
});

r.post("/:id/members", async (c) => {
  const p = await loadProject(c, c.req.param("id"), "owner");
  const b = await body(c);
  const who = str(b.user, "user", 254);
  const role = oneOf(b.role ?? "viewer", "role", ["editor", "viewer"] as const);
  const target = await one<{ id: string }>(
    c.env.DB,
    "SELECT id FROM users WHERE status = 'active' AND (username = ? COLLATE NOCASE OR email = ? COLLATE NOCASE) LIMIT 1",
    who,
    who,
  );
  if (!target) throw notFound("user");
  if (await one(c.env.DB, "SELECT 1 AS x FROM project_members WHERE project_id = ? AND user_id = ?", p.id, target.id))
    throw conflict("conflict", "user is already a member");
  await run(c.env.DB, "INSERT INTO project_members (project_id, user_id, role, created_at) VALUES (?, ?, ?, ?)", p.id, target.id, role, now());
  const m = await one<MemberRow>(c.env.DB, `${MEMBER_SELECT} WHERE m.project_id = ? AND m.user_id = ?`, p.id, target.id);
  return c.json(toMember(m!), 201);
});

r.patch("/:id/members/:userId", async (c) => {
  const p = await loadProject(c, c.req.param("id"), "owner");
  const userId = c.req.param("userId");
  const role = oneOf((await body(c)).role, "role", ["editor", "viewer"] as const);
  if (userId === p.owner_id) throw badRequest("the owner's role cannot be changed");
  if (!(await run(c.env.DB, "UPDATE project_members SET role = ? WHERE project_id = ? AND user_id = ?", role, p.id, userId)))
    throw notFound("member");
  const m = await one<MemberRow>(c.env.DB, `${MEMBER_SELECT} WHERE m.project_id = ? AND m.user_id = ?`, p.id, userId);
  return c.json(toMember(m!));
});

r.delete("/:id/members/:userId", async (c) => {
  const u = requireUser(c);
  const userId = c.req.param("userId");
  // Members may leave on their own; everything else needs the owner.
  const p = await loadProject(c, c.req.param("id"), userId === u.id ? "viewer" : "owner");
  if (userId === p.owner_id) throw forbidden("the owner cannot leave; delete the project instead");
  if (!(await run(c.env.DB, "DELETE FROM project_members WHERE project_id = ? AND user_id = ?", p.id, userId))) throw notFound("member");
  return c.body(null, 204);
});

export default r;
