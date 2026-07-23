import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";

import {
  manimProjectIdSchema,
  manimProjectNameSchema,
} from "../src/render-pipeline/contracts";
import { HttpError } from "./http/json";

export type ManimProjectSeed = Readonly<{
  id?: string;
  kind?: ManimProjectKind;
  name?: string;
  root: string;
}>;

export type ManimProjectKind = "existing" | "managed";

export type ResolvedManimProject = Readonly<{
  canonicalRoot: string;
  kind: ManimProjectKind;
  projectId: string;
  projectName: string;
}>;

const storedProjectV1Schema = z.object({
  id: manimProjectIdSchema,
  name: manimProjectNameSchema,
  root: z.string().trim().min(1),
}).strict();

const storedProjectSchema = storedProjectV1Schema.extend({
  kind: z.enum(["existing", "managed"]),
}).strict();

const storedCatalogSchema = z.discriminatedUnion("version", [
  z.object({
    projects: z.array(storedProjectV1Schema).max(64),
    version: z.literal(1),
  }).strict(),
  z.object({
    projects: z.array(storedProjectSchema).max(64),
    version: z.literal(2),
  }).strict(),
]);

const MANAGED_WORKSPACE_STARTER = `from manim import *

class MainScene(Scene):
    def construct(self):
        # poietra:anchor 0.000
        self.wait(1)
`;

function opaqueProjectId(canonicalRoot: string) {
  return `project-${createHash("sha256").update(canonicalRoot).digest("hex").slice(0, 16)}`;
}

function projectName(value: string | undefined, canonicalRoot: string) {
  const parsed = manimProjectNameSchema.safeParse(value ?? (basename(canonicalRoot) || "Manim Project"));
  if (!parsed.success) throw new TypeError("Manim project name must contain 1 to 120 characters.");
  return parsed.data;
}

export function resolveManimProjects(
  projects: readonly ManimProjectSeed[],
): readonly ResolvedManimProject[] {
  if (projects.length > 64) throw new TypeError("The Manim project registry accepts at most 64 projects.");
  const canonicalRoots = new Set<string>();
  const projectIds = new Set<string>();
  return projects.map((project) => {
    let canonicalRoot: string;
    try {
      canonicalRoot = realpathSync(resolve(project.root));
      if (!statSync(canonicalRoot).isDirectory()) throw new Error("not a directory");
    } catch {
      throw new TypeError(`Configured Manim project ${project.name ?? project.id ?? "root"} is not a directory.`);
    }
    if (canonicalRoots.has(canonicalRoot)) throw new TypeError("A Manim project root may only be registered once.");
    canonicalRoots.add(canonicalRoot);
    const projectId = project.id ?? opaqueProjectId(canonicalRoot);
    if (!manimProjectIdSchema.safeParse(projectId).success) {
      throw new TypeError("Manim project ID must be an opaque lower-case identifier.");
    }
    if (projectIds.has(projectId)) throw new TypeError(`Duplicate Manim project ID ${projectId}.`);
    projectIds.add(projectId);
    return {
      canonicalRoot,
      kind: project.kind ?? "existing",
      projectId,
      projectName: projectName(project.name, canonicalRoot),
    };
  });
}

export class PersistentManimProjectCatalog {
  private entries: readonly ResolvedManimProject[];
  private quarantined: readonly z.infer<typeof storedProjectSchema>[] = [];
  private readonly managedRoot: string;
  private readonly projectIdFactory: () => string;
  private readonly statePath: string;
  private readonly trashRoot: string;

  constructor(options: Readonly<{
    dataRoot: string;
    projectIdFactory?: () => string;
    seedProjects: readonly ManimProjectSeed[];
  }>) {
    mkdirSync(resolve(options.dataRoot), { mode: 0o700, recursive: true });
    const dataRoot = realpathSync(resolve(options.dataRoot));
    const requestedManagedRoot = join(dataRoot, ".workspaces");
    mkdirSync(requestedManagedRoot, { mode: 0o700, recursive: true });
    this.managedRoot = realpathSync(requestedManagedRoot);
    this.assertManagedRoot();
    const requestedTrashRoot = join(dataRoot, ".trash");
    mkdirSync(requestedTrashRoot, { mode: 0o700, recursive: true });
    this.trashRoot = realpathSync(requestedTrashRoot);
    this.assertPrivateDirectory(this.trashRoot, "Studio Trash");
    this.projectIdFactory = options.projectIdFactory
      ?? (() => `project-${randomUUID().replaceAll("-", "")}`);
    this.statePath = join(dataRoot, "workspace-catalog.json");
    if (existsSync(this.statePath)) {
      let stored: z.infer<typeof storedCatalogSchema>;
      try {
        stored = storedCatalogSchema.parse(JSON.parse(readFileSync(this.statePath, "utf8")));
      } catch {
        throw new TypeError("The persisted Manim workspace catalog is invalid.");
      }
      const normalizedProjects: readonly z.infer<typeof storedProjectSchema>[] = stored.version === 1
        ? stored.projects.map((project) => ({ ...project, kind: "existing" as const }))
        : stored.projects;
      const availableProjects: ResolvedManimProject[] = [];
      const quarantinedProjects: z.infer<typeof storedProjectSchema>[] = [];
      normalizedProjects.forEach((project) => {
        try {
          const resolvedProject = resolveManimProjects([project])[0]!;
          if (project.kind === "managed" && !this.isManagedProjectRoot(resolvedProject)) {
            quarantinedProjects.push(project);
            return;
          }
          const conflictsWithAvailableProject = availableProjects.some((availableProject) => (
            availableProject.projectId === resolvedProject.projectId
            || availableProject.canonicalRoot === resolvedProject.canonicalRoot
          ));
          if (conflictsWithAvailableProject) {
            quarantinedProjects.push(project);
          } else {
            availableProjects.push(resolvedProject);
          }
        } catch {
          quarantinedProjects.push(project);
        }
      });
      this.quarantined = quarantinedProjects;
      this.entries = availableProjects;
      return;
    }
    this.entries = resolveManimProjects(options.seedProjects);
    this.persist(this.entries);
  }

  projects() {
    return this.entries;
  }

  create(name: string, root: string) {
    const parsedName = this.validateNewProject(name);
    let created: ResolvedManimProject;
    try {
      created = resolveManimProjects([{
        kind: "existing",
        name: parsedName.data,
        root,
      }])[0]!;
    } catch {
      throw new HttpError("The selected workspace folder is not an accessible directory.", 400);
    }
    return this.register(created);
  }

  createManaged(name: string) {
    const parsedName = this.validateNewProject(name);
    this.assertManagedRoot();
    const projectId = this.projectIdFactory();
    if (!manimProjectIdSchema.safeParse(projectId).success) {
      throw new TypeError("The managed workspace ID factory returned an invalid ID.");
    }
    const workspaceRoot = join(this.managedRoot, projectId);
    let workspaceCreated = false;
    try {
      mkdirSync(workspaceRoot, { mode: 0o700 });
      workspaceCreated = true;
      writeFileSync(join(workspaceRoot, "main.py"), MANAGED_WORKSPACE_STARTER, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      const created = resolveManimProjects([{
        id: projectId,
        kind: "managed",
        name: parsedName.data,
        root: workspaceRoot,
      }])[0]!;
      return this.register(created);
    } catch (error) {
      if (workspaceCreated) rmSync(workspaceRoot, { force: true, recursive: true });
      throw error;
    }
  }

  rollbackManagedCreation(projectId: string) {
    const project = this.entries.find((entry) => entry.projectId === projectId);
    if (
      !project
      || project.kind !== "managed"
      || dirname(project.canonicalRoot) !== this.managedRoot
      || basename(project.canonicalRoot) !== project.projectId
    ) {
      throw new TypeError("Only a newly managed workspace can be rolled back.");
    }
    this.unregister(projectId);
    rmSync(project.canonicalRoot, { force: true, recursive: true });
  }

  remove(projectId: string) {
    const project = this.entries.find((entry) => entry.projectId === projectId);
    if (!project) throw new HttpError("Configured Manim project not found.", 404);
    if (project.kind === "existing") {
      this.unregister(projectId);
      return project;
    }
    this.assertManagedRoot();
    this.assertPrivateDirectory(this.trashRoot, "Studio Trash");
    if (!this.isManagedProjectRoot(project)) {
      throw new HttpError("The managed workspace location is invalid and cannot be moved safely.", 409);
    }
    const trashedRoot = join(this.trashRoot, `${project.projectId}-${randomUUID()}`);
    renameSync(project.canonicalRoot, trashedRoot);
    try {
      this.unregister(projectId);
    } catch (error) {
      try {
        renameSync(trashedRoot, project.canonicalRoot);
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], "Could not roll back the managed workspace removal.");
      }
      throw error;
    }
    return project;
  }

  private register(created: ResolvedManimProject) {
    if (this.entries.some((project) => project.canonicalRoot === created.canonicalRoot)) {
      throw new HttpError("That workspace folder is already registered.", 409);
    }
    if (this.entries.some((project) => project.projectId === created.projectId)) {
      throw new HttpError("That workspace conflicts with an existing registration.", 409);
    }
    const conflictsWithQuarantinedProject = this.quarantined.some((project) => {
      if (project.id === created.projectId) return true;
      try {
        return realpathSync(resolve(project.root)) === created.canonicalRoot;
      } catch {
        return resolve(project.root) === created.canonicalRoot;
      }
    });
    if (conflictsWithQuarantinedProject) {
      throw new HttpError("That workspace is already registered but its folder was unavailable when Studio started.", 409);
    }
    const next = [...this.entries, created];
    this.persist(next);
    this.entries = next;
    return created;
  }

  private assertManagedRoot() {
    this.assertPrivateDirectory(this.managedRoot, "managed workspace directory");
  }

  private assertPrivateDirectory(directory: string, label: string) {
    let metadata;
    try {
      metadata = lstatSync(directory);
      if (metadata.isSymbolicLink() || !metadata.isDirectory() || realpathSync(directory) !== directory) {
        throw new Error("unsafe private directory");
      }
    } catch {
      throw new TypeError(`The ${label} must be a real local directory.`);
    }
  }

  private isManagedProjectRoot(project: ResolvedManimProject) {
    try {
      const metadata = lstatSync(project.canonicalRoot);
      return !metadata.isSymbolicLink()
        && metadata.isDirectory()
        && dirname(project.canonicalRoot) === this.managedRoot
        && basename(project.canonicalRoot) === project.projectId;
    } catch {
      return false;
    }
  }

  private validateNewProject(name: string) {
    const parsedName = manimProjectNameSchema.safeParse(name);
    if (!parsedName.success) throw new HttpError("Workspace name must contain 1 to 120 characters.", 400);
    if (this.entries.length + this.quarantined.length >= 64) {
      throw new HttpError("Studio supports at most 64 registered workspaces.", 409);
    }
    return parsedName;
  }

  rename(projectId: string, name: string) {
    const parsedName = manimProjectNameSchema.safeParse(name);
    if (!parsedName.success) throw new HttpError("Workspace name must contain 1 to 120 characters.", 400);
    const index = this.entries.findIndex((project) => project.projectId === projectId);
    if (index < 0) throw new HttpError("Configured Manim project not found.", 404);
    const current = this.entries[index]!;
    const renamed = { ...current, projectName: parsedName.data };
    const next = this.entries.map((project, projectIndex) => projectIndex === index ? renamed : project);
    this.persist(next);
    this.entries = next;
    return renamed;
  }

  unregister(projectId: string) {
    if (!this.entries.some((project) => project.projectId === projectId)) {
      throw new HttpError("Configured Manim project not found.", 404);
    }
    const next = this.entries.filter((project) => project.projectId !== projectId);
    this.persist(next);
    this.entries = next;
  }

  private persist(projects: readonly ResolvedManimProject[]) {
    const temporaryPath = join(dirname(this.statePath), `.catalog-${randomUUID()}.tmp`);
    const payload = `${JSON.stringify({
      projects: projects.map((project) => ({
        id: project.projectId,
        kind: project.kind,
        name: project.projectName,
        root: project.canonicalRoot,
      })).concat(this.quarantined),
      version: 2,
    }, null, 2)}\n`;
    try {
      writeFileSync(temporaryPath, payload, { encoding: "utf8", flag: "wx", mode: 0o600 });
      renameSync(temporaryPath, this.statePath);
    } finally {
      rmSync(temporaryPath, { force: true });
    }
  }
}
