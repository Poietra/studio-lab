import type {
  EditorCollaborationAuthorizationGrantV1,
  EditorCollaborationAuthorizationLeaseV1,
} from "./editor-collaboration-authorization";

export type EditorCollaborationRoomIdentityV1 = Pick<
  EditorCollaborationAuthorizationGrantV1,
  "documentKey" | "epoch" | "organizationId" | "projectId"
>;

export type EditorCollaborationRequestedRoomV1 = Omit<EditorCollaborationRoomIdentityV1, "organizationId">;

export type EditorCollaborationSessionAuthorizationV1 =
  | Readonly<{ grant: EditorCollaborationAuthorizationGrantV1; kind: "authorized" }>
  | Readonly<{ kind: "denied" }>
  | Readonly<{ kind: "invalid-session" }>;

export interface EditorCollaborationAuthorizationRepositoryV1 {
  authorizeSession(
    sessionTokenHash: Uint8Array,
    room: EditorCollaborationRequestedRoomV1,
    signal?: AbortSignal,
  ): Promise<EditorCollaborationSessionAuthorizationV1>;
  close(): Promise<void>;
  revalidateAuthorizations(
    leases: readonly EditorCollaborationAuthorizationLeaseV1[],
    signal?: AbortSignal,
  ): Promise<readonly (EditorCollaborationAuthorizationGrantV1 | null)[]>;
}
