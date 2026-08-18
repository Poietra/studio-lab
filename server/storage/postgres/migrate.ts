import { createHash } from "node:crypto";

import type { Pool } from "pg";
import { ACCOUNT_INVITATION_QUOTA_MIGRATION_V24_CHECKSUM } from "./account-invitation-quota-schema";
import { ACCOUNT_INVITATION_MIGRATION_V22_CHECKSUM } from "./account-invitation-schema";
import { ACCOUNT_ORGANIZATION_MIGRATION_V11_CHECKSUM } from "./account-organization-schema";
import { ACCOUNT_ORGANIZATION_SWITCH_MUTATION_MIGRATION_V28_CHECKSUM } from "./account-organization-switch-mutation-schema";
import { ACCOUNT_SESSION_MIGRATION_V12_CHECKSUM } from "./account-session-schema";
import { BILLING_ENTITLEMENT_GRANT_MIGRATION_V32_CHECKSUM } from "./billing-entitlement-grant-schema";
import { BILLING_ENTITLEMENT_MIGRATION_V14_CHECKSUM } from "./billing-entitlement-schema";
import { CLIENT_EXPORT_PUBLICATION_MIGRATION_V31_CHECKSUM } from "./client-export-publication-schema";
import { CLIENT_THUMBNAIL_PUBLICATION_MIGRATION_V33_CHECKSUM } from "./client-thumbnail-publication-schema";
import { COLLABORATION_AUTHORIZATION_MIGRATION_V26_CHECKSUM } from "./collaboration-authorization-schema";
import { DURABLE_RETENTION_MIGRATION_V6_CHECKSUM } from "./durable-retention-schema";
import { EDITOR_DOCUMENT_ORIGIN_MIGRATION_V30_CHECKSUM } from "./editor-document-origin-schema";
import { EDITOR_DOCUMENT_MIGRATION_V17_CHECKSUM } from "./editor-document-schema";
import { EDITOR_MUTATION_MIGRATION_V18_CHECKSUM } from "./editor-mutation-schema";
import { EDITOR_SESSION_SNAPSHOT_MIGRATION_V23_CHECKSUM } from "./editor-session-snapshot-schema";
import { IMMUTABLE_OBJECT_GENERATION_MIGRATION_V20_CHECKSUM } from "./immutable-object-generation-schema";
import workspaceSourceSqlV1 from "./migrations/0001_workspace_source.sql?raw";
import renderSessionSqlV2 from "./migrations/0002_render_sessions.sql?raw";
import snapshotPublicationSqlV3 from "./migrations/0003_snapshot_publications.sql?raw";
import renderArtifactSqlV4 from "./migrations/0004_render_artifacts.sql?raw";
import projectPngSqlV5 from "./migrations/0005_project_png.sql?raw";
import renderSessionRetentionSqlV6 from "./migrations/0006_render_session_retention.sql?raw";
import renderCancellationSqlV7 from "./migrations/0007_render_cancellations.sql?raw";
import renderSessionFailureSqlV8 from "./migrations/0008_render_failure_codes.sql?raw";
import renderSessionCpuFailureSqlV9 from "./migrations/0009_render_cpu_limit.sql?raw";
import snapshotRuntimeDigestSqlV10 from "./migrations/0010_snapshot_runtime_digest.sql?raw";
import accountOrganizationSqlV11 from "./migrations/0011_accounts_organizations.sql?raw";
import accountSessionSqlV12 from "./migrations/0012_account_sessions.sql?raw";
import oidcLoginSqlV13 from "./migrations/0013_oidc_login.sql?raw";
import billingEntitlementSqlV14 from "./migrations/0014_billing_entitlements.sql?raw";
import renderSessionUsageSqlV15 from "./migrations/0015_render_session_usage.sql?raw";
import stripeBillingSqlV16 from "./migrations/0016_stripe_billing_control_plane.sql?raw";
import editorDocumentSqlV17 from "./migrations/0017_editor_documents.sql?raw";
import editorMutationSqlV18 from "./migrations/0018_editor_mutation_semantics.sql?raw";
import renderSessionSceneNameSqlV19 from "./migrations/0019_render_session_scene_name.sql?raw";
import immutableObjectGenerationSqlV20 from "./migrations/0020_immutable_object_generations.sql?raw";
import renderArtifactTombstoneSqlV21 from "./migrations/0021_render_artifact_tombstones.sql?raw";
import accountInvitationSqlV22 from "./migrations/0022_account_invitations.sql?raw";
import editorSessionSnapshotSqlV23 from "./migrations/0023_editor_session_snapshots.sql?raw";
import accountInvitationQuotaSqlV24 from "./migrations/0024_account_invitation_quotas.sql?raw";
import snapshotRuntimeConfigHeadSqlV25 from "./migrations/0025_snapshot_runtime_config_heads.sql?raw";
import collaborationAuthorizationSqlV26 from "./migrations/0026_collaboration_authorization_ids.sql?raw";
import snapshotPublicationTombstoneRetentionSqlV27 from "./migrations/0027_snapshot_publication_tombstone_retention.sql?raw";
import accountOrganizationSwitchMutationSqlV28 from "./migrations/0028_account_organization_switch_mutations.sql?raw";
import runtimeCellAssignmentSqlV29 from "./migrations/0029_runtime_cell_assignments.sql?raw";
import editorDocumentOriginSqlV30 from "./migrations/0030_editor_document_origins.sql?raw";
import clientExportPublicationSqlV31 from "./migrations/0031_client_export_publications.sql?raw";
import billingEntitlementGrantSqlV32 from "./migrations/0032_billing_entitlement_grants.sql?raw";
import clientThumbnailPublicationSqlV33 from "./migrations/0033_client_thumbnail_publications.sql?raw";
import { OIDC_LOGIN_MIGRATION_V13_CHECKSUM } from "./oidc-login-schema";
import { RENDER_ARTIFACT_MIGRATION_V4_CHECKSUM } from "./postgres-artifact-repository";
import { PROJECT_PNG_MIGRATION_V5_CHECKSUM } from "./postgres-project-png-repository";
import { RENDER_SESSION_MIGRATION_V2_CHECKSUM } from "./postgres-render-session-repository";
import { SNAPSHOT_PUBLICATION_MIGRATION_V3_CHECKSUM } from "./postgres-snapshot-publication-repository";
import { WORKSPACE_SOURCE_MIGRATION_V1_CHECKSUM } from "./postgres-workspace-source-repository";
import { RENDER_ARTIFACT_TOMBSTONE_MIGRATION_V21_CHECKSUM } from "./render-artifact-tombstone-schema";
import { RENDER_CANCELLATION_MIGRATION_V7_CHECKSUM } from "./render-cancellation-schema";
import { RENDER_SESSION_CPU_FAILURE_MIGRATION_V9_CHECKSUM } from "./render-session-cpu-failure-schema";
import { RENDER_SESSION_FAILURE_MIGRATION_V8_CHECKSUM } from "./render-session-failure-schema";
import { RENDER_SESSION_SCENE_NAME_MIGRATION_V19_CHECKSUM } from "./render-session-scene-name-schema";
import { RENDER_SESSION_USAGE_MIGRATION_V15_CHECKSUM } from "./render-session-usage-schema";
import { RUNTIME_CELL_ASSIGNMENT_MIGRATION_V29_CHECKSUM } from "./runtime-cell-assignment-schema";
import { SNAPSHOT_PUBLICATION_TOMBSTONE_RETENTION_MIGRATION_V27_CHECKSUM } from "./snapshot-publication-tombstone-retention-schema";
import { SNAPSHOT_RUNTIME_CONFIG_HEAD_MIGRATION_V25_CHECKSUM } from "./snapshot-runtime-config-head-schema";
import { SNAPSHOT_RUNTIME_DIGEST_MIGRATION_V10_CHECKSUM } from "./snapshot-runtime-digest-schema";
import { STRIPE_BILLING_MIGRATION_V16_CHECKSUM } from "./stripe-billing-schema";

export { ACCOUNT_INVITATION_QUOTA_MIGRATION_V24_CHECKSUM } from "./account-invitation-quota-schema";
export { ACCOUNT_INVITATION_MIGRATION_V22_CHECKSUM } from "./account-invitation-schema";
export { ACCOUNT_ORGANIZATION_MIGRATION_V11_CHECKSUM } from "./account-organization-schema";
export { ACCOUNT_ORGANIZATION_SWITCH_MUTATION_MIGRATION_V28_CHECKSUM } from "./account-organization-switch-mutation-schema";
export { ACCOUNT_SESSION_MIGRATION_V12_CHECKSUM } from "./account-session-schema";
export { BILLING_ENTITLEMENT_GRANT_MIGRATION_V32_CHECKSUM } from "./billing-entitlement-grant-schema";
export { BILLING_ENTITLEMENT_MIGRATION_V14_CHECKSUM } from "./billing-entitlement-schema";
export { CLIENT_EXPORT_PUBLICATION_MIGRATION_V31_CHECKSUM } from "./client-export-publication-schema";
export { CLIENT_THUMBNAIL_PUBLICATION_MIGRATION_V33_CHECKSUM } from "./client-thumbnail-publication-schema";
export { COLLABORATION_AUTHORIZATION_MIGRATION_V26_CHECKSUM } from "./collaboration-authorization-schema";
export { EDITOR_DOCUMENT_ORIGIN_MIGRATION_V30_CHECKSUM } from "./editor-document-origin-schema";
export { EDITOR_DOCUMENT_MIGRATION_V17_CHECKSUM } from "./editor-document-schema";
export { EDITOR_MUTATION_MIGRATION_V18_CHECKSUM } from "./editor-mutation-schema";
export { EDITOR_SESSION_SNAPSHOT_MIGRATION_V23_CHECKSUM } from "./editor-session-snapshot-schema";
export { IMMUTABLE_OBJECT_GENERATION_MIGRATION_V20_CHECKSUM } from "./immutable-object-generation-schema";
export { OIDC_LOGIN_MIGRATION_V13_CHECKSUM } from "./oidc-login-schema";
export { SNAPSHOT_PUBLICATION_MIGRATION_V3_CHECKSUM } from "./postgres-snapshot-publication-repository";
export { RENDER_ARTIFACT_TOMBSTONE_MIGRATION_V21_CHECKSUM } from "./render-artifact-tombstone-schema";
export { RENDER_CANCELLATION_MIGRATION_V7_CHECKSUM } from "./render-cancellation-schema";
export { RENDER_SESSION_CPU_FAILURE_MIGRATION_V9_CHECKSUM } from "./render-session-cpu-failure-schema";
export { RENDER_SESSION_FAILURE_MIGRATION_V8_CHECKSUM } from "./render-session-failure-schema";
export { RENDER_SESSION_SCENE_NAME_MIGRATION_V19_CHECKSUM } from "./render-session-scene-name-schema";
export { RENDER_SESSION_USAGE_MIGRATION_V15_CHECKSUM } from "./render-session-usage-schema";
export { RUNTIME_CELL_ASSIGNMENT_MIGRATION_V29_CHECKSUM } from "./runtime-cell-assignment-schema";
export { SNAPSHOT_PUBLICATION_TOMBSTONE_RETENTION_MIGRATION_V27_CHECKSUM } from "./snapshot-publication-tombstone-retention-schema";
export { SNAPSHOT_RUNTIME_CONFIG_HEAD_MIGRATION_V25_CHECKSUM } from "./snapshot-runtime-config-head-schema";
export { SNAPSHOT_RUNTIME_DIGEST_MIGRATION_V10_CHECKSUM } from "./snapshot-runtime-digest-schema";
export { STRIPE_BILLING_MIGRATION_V16_CHECKSUM } from "./stripe-billing-schema";

const DURABLE_STORAGE_MIGRATION_LOCK = "5784133447825795121";

type DurableStorageMigration<Version extends number = number> = Readonly<{
  checksum: string;
  checksumMismatch: string;
  installedMismatch: string;
  missingPrerequisite?: string;
  prerequisiteMismatch?: string;
  source: string;
  version: Version;
}>;

export function durableStorageMigrationChecksum(source: string) {
  return createHash("sha256").update(source, "utf8").digest("hex");
}

export function workspaceSourceMigrationChecksumV1(source: string) {
  return durableStorageMigrationChecksum(source);
}

export function renderSessionMigrationChecksumV2(source: string) {
  return durableStorageMigrationChecksum(source);
}
export const WORKSPACE_SOURCE_MIGRATION_V1_SOURCE = workspaceSourceSqlV1;
export const RENDER_SESSION_MIGRATION_V2_SOURCE = renderSessionSqlV2;
export const SNAPSHOT_PUBLICATION_MIGRATION_V3_SOURCE = snapshotPublicationSqlV3;
export const RENDER_ARTIFACT_MIGRATION_V4_SOURCE = renderArtifactSqlV4;
export const PROJECT_PNG_MIGRATION_V5_SOURCE = projectPngSqlV5;
export const RENDER_SESSION_RETENTION_MIGRATION_V6_SOURCE = renderSessionRetentionSqlV6;
export const RENDER_CANCELLATION_MIGRATION_V7_SOURCE = renderCancellationSqlV7;
export const RENDER_SESSION_FAILURE_MIGRATION_V8_SOURCE = renderSessionFailureSqlV8;
export const RENDER_SESSION_CPU_FAILURE_MIGRATION_V9_SOURCE = renderSessionCpuFailureSqlV9;
export const SNAPSHOT_RUNTIME_DIGEST_MIGRATION_V10_SOURCE = snapshotRuntimeDigestSqlV10;
export const ACCOUNT_ORGANIZATION_MIGRATION_V11_SOURCE = accountOrganizationSqlV11;
export const ACCOUNT_SESSION_MIGRATION_V12_SOURCE = accountSessionSqlV12;
export const OIDC_LOGIN_MIGRATION_V13_SOURCE = oidcLoginSqlV13;
export const BILLING_ENTITLEMENT_MIGRATION_V14_SOURCE = billingEntitlementSqlV14;
export const RENDER_SESSION_USAGE_MIGRATION_V15_SOURCE = renderSessionUsageSqlV15;
export const STRIPE_BILLING_MIGRATION_V16_SOURCE = stripeBillingSqlV16;
export const EDITOR_DOCUMENT_MIGRATION_V17_SOURCE = editorDocumentSqlV17;
export const EDITOR_MUTATION_MIGRATION_V18_SOURCE = editorMutationSqlV18;
export const RENDER_SESSION_SCENE_NAME_MIGRATION_V19_SOURCE = renderSessionSceneNameSqlV19;
export const IMMUTABLE_OBJECT_GENERATION_MIGRATION_V20_SOURCE = immutableObjectGenerationSqlV20;
export const RENDER_ARTIFACT_TOMBSTONE_MIGRATION_V21_SOURCE = renderArtifactTombstoneSqlV21;
export const ACCOUNT_INVITATION_MIGRATION_V22_SOURCE = accountInvitationSqlV22;
export const EDITOR_SESSION_SNAPSHOT_MIGRATION_V23_SOURCE = editorSessionSnapshotSqlV23;
export const ACCOUNT_INVITATION_QUOTA_MIGRATION_V24_SOURCE = accountInvitationQuotaSqlV24;
export const SNAPSHOT_RUNTIME_CONFIG_HEAD_MIGRATION_V25_SOURCE = snapshotRuntimeConfigHeadSqlV25;
export const COLLABORATION_AUTHORIZATION_MIGRATION_V26_SOURCE = collaborationAuthorizationSqlV26;
export const SNAPSHOT_PUBLICATION_TOMBSTONE_RETENTION_MIGRATION_V27_SOURCE =
  snapshotPublicationTombstoneRetentionSqlV27;
export const ACCOUNT_ORGANIZATION_SWITCH_MUTATION_MIGRATION_V28_SOURCE = accountOrganizationSwitchMutationSqlV28;
export const RUNTIME_CELL_ASSIGNMENT_MIGRATION_V29_SOURCE = runtimeCellAssignmentSqlV29;
export const EDITOR_DOCUMENT_ORIGIN_MIGRATION_V30_SOURCE = editorDocumentOriginSqlV30;
export const CLIENT_EXPORT_PUBLICATION_MIGRATION_V31_SOURCE = clientExportPublicationSqlV31;
export const BILLING_ENTITLEMENT_GRANT_MIGRATION_V32_SOURCE = billingEntitlementGrantSqlV32;
export const CLIENT_THUMBNAIL_PUBLICATION_MIGRATION_V33_SOURCE = clientThumbnailPublicationSqlV33;

const workspaceSourceMigrationV1: DurableStorageMigration<1> = Object.freeze({
  checksum: WORKSPACE_SOURCE_MIGRATION_V1_CHECKSUM,
  checksumMismatch: "The workspace/source migration checksum is invalid.",
  installedMismatch: "The installed workspace/source schema does not match migration v1.",
  source: WORKSPACE_SOURCE_MIGRATION_V1_SOURCE,
  version: 1,
});

const renderSessionMigrationV2: DurableStorageMigration<2> = Object.freeze({
  checksum: RENDER_SESSION_MIGRATION_V2_CHECKSUM,
  checksumMismatch: "The render-session migration checksum is invalid.",
  installedMismatch: "The installed render-session schema does not match migration v2.",
  missingPrerequisite: "Render-session migration v2 requires workspace/source migration v1.",
  prerequisiteMismatch: "Render-session migration v2 requires an exact workspace/source migration v1.",
  source: RENDER_SESSION_MIGRATION_V2_SOURCE,
  version: 2,
});

const snapshotPublicationMigrationV3: DurableStorageMigration<3> = Object.freeze({
  checksum: SNAPSHOT_PUBLICATION_MIGRATION_V3_CHECKSUM,
  checksumMismatch: "The snapshot-publication migration checksum is invalid.",
  installedMismatch: "The installed snapshot-publication schema does not match migration v3.",
  missingPrerequisite: "Snapshot-publication migration v3 requires durable storage migrations v1 and v2.",
  prerequisiteMismatch: "Snapshot-publication migration v3 requires exact durable storage migrations v1 and v2.",
  source: SNAPSHOT_PUBLICATION_MIGRATION_V3_SOURCE,
  version: 3,
});

const renderArtifactMigrationV4: DurableStorageMigration<4> = Object.freeze({
  checksum: RENDER_ARTIFACT_MIGRATION_V4_CHECKSUM,
  checksumMismatch: "The render-artifact migration checksum is invalid.",
  installedMismatch: "The installed render-artifact schema does not match migration v4.",
  missingPrerequisite: "Render-artifact migration v4 requires durable storage migrations v1 through v3.",
  prerequisiteMismatch: "Render-artifact migration v4 requires exact durable storage migrations v1 through v3.",
  source: RENDER_ARTIFACT_MIGRATION_V4_SOURCE,
  version: 4,
});

const projectPngMigrationV5: DurableStorageMigration<5> = Object.freeze({
  checksum: PROJECT_PNG_MIGRATION_V5_CHECKSUM,
  checksumMismatch: "The project image.png migration checksum is invalid.",
  installedMismatch: "The installed project image.png schema does not match migration v5.",
  missingPrerequisite: "Project image.png migration v5 requires durable storage migrations v1 through v4.",
  prerequisiteMismatch: "Project image.png migration v5 requires exact durable storage migrations v1 through v4.",
  source: PROJECT_PNG_MIGRATION_V5_SOURCE,
  version: 5,
});

const renderSessionRetentionMigrationV6: DurableStorageMigration<6> = Object.freeze({
  checksum: DURABLE_RETENTION_MIGRATION_V6_CHECKSUM,
  checksumMismatch: "The render-session retention migration checksum is invalid.",
  installedMismatch: "The installed render-session retention schema does not match migration v6.",
  missingPrerequisite: "Render-session retention migration v6 requires durable storage migrations v1 through v5.",
  prerequisiteMismatch:
    "Render-session retention migration v6 requires exact durable storage migrations v1 through v5.",
  source: RENDER_SESSION_RETENTION_MIGRATION_V6_SOURCE,
  version: 6,
});

const renderCancellationMigrationV7: DurableStorageMigration<7> = Object.freeze({
  checksum: RENDER_CANCELLATION_MIGRATION_V7_CHECKSUM,
  checksumMismatch: "The render-cancellation migration checksum is invalid.",
  installedMismatch: "The installed render-cancellation schema does not match migration v7.",
  missingPrerequisite: "Render-cancellation migration v7 requires durable storage migrations v1 through v6.",
  prerequisiteMismatch: "Render-cancellation migration v7 requires exact durable storage migrations v1 through v6.",
  source: RENDER_CANCELLATION_MIGRATION_V7_SOURCE,
  version: 7,
});

const renderSessionFailureMigrationV8: DurableStorageMigration<8> = Object.freeze({
  checksum: RENDER_SESSION_FAILURE_MIGRATION_V8_CHECKSUM,
  checksumMismatch: "The render-session failure migration checksum is invalid.",
  installedMismatch: "The installed render-session failure schema does not match migration v8.",
  missingPrerequisite: "Render-session failure migration v8 requires durable storage migrations v1 through v7.",
  prerequisiteMismatch: "Render-session failure migration v8 requires exact durable storage migrations v1 through v7.",
  source: RENDER_SESSION_FAILURE_MIGRATION_V8_SOURCE,
  version: 8,
});

const renderSessionCpuFailureMigrationV9: DurableStorageMigration<9> = Object.freeze({
  checksum: RENDER_SESSION_CPU_FAILURE_MIGRATION_V9_CHECKSUM,
  checksumMismatch: "The render-session CPU failure migration checksum is invalid.",
  installedMismatch: "The installed render-session CPU failure schema does not match migration v9.",
  missingPrerequisite: "Render-session CPU failure migration v9 requires durable storage migrations v1 through v8.",
  prerequisiteMismatch:
    "Render-session CPU failure migration v9 requires exact durable storage migrations v1 through v8.",
  source: RENDER_SESSION_CPU_FAILURE_MIGRATION_V9_SOURCE,
  version: 9,
});

const snapshotRuntimeDigestMigrationV10: DurableStorageMigration<10> = Object.freeze({
  checksum: SNAPSHOT_RUNTIME_DIGEST_MIGRATION_V10_CHECKSUM,
  checksumMismatch: "The snapshot runtime-digest migration checksum is invalid.",
  installedMismatch: "The installed snapshot runtime-digest schema does not match migration v10.",
  missingPrerequisite: "Snapshot runtime-digest migration v10 requires durable storage migrations v1 through v9.",
  prerequisiteMismatch:
    "Snapshot runtime-digest migration v10 requires exact durable storage migrations v1 through v9.",
  source: SNAPSHOT_RUNTIME_DIGEST_MIGRATION_V10_SOURCE,
  version: 10,
});

const accountOrganizationMigrationV11: DurableStorageMigration<11> = Object.freeze({
  checksum: ACCOUNT_ORGANIZATION_MIGRATION_V11_CHECKSUM,
  checksumMismatch: "The account/organization migration checksum is invalid.",
  installedMismatch: "The installed account/organization schema does not match migration v11.",
  missingPrerequisite: "Account/organization migration v11 requires durable storage migrations v1 through v10.",
  prerequisiteMismatch: "Account/organization migration v11 requires exact durable storage migrations v1 through v10.",
  source: ACCOUNT_ORGANIZATION_MIGRATION_V11_SOURCE,
  version: 11,
});

const accountSessionMigrationV12: DurableStorageMigration<12> = Object.freeze({
  checksum: ACCOUNT_SESSION_MIGRATION_V12_CHECKSUM,
  checksumMismatch: "The account-session migration checksum is invalid.",
  installedMismatch: "The installed account-session schema does not match migration v12.",
  missingPrerequisite: "Account-session migration v12 requires durable storage migrations v1 through v11.",
  prerequisiteMismatch: "Account-session migration v12 requires exact durable storage migrations v1 through v11.",
  source: ACCOUNT_SESSION_MIGRATION_V12_SOURCE,
  version: 12,
});

const oidcLoginMigrationV13: DurableStorageMigration<13> = Object.freeze({
  checksum: OIDC_LOGIN_MIGRATION_V13_CHECKSUM,
  checksumMismatch: "The OIDC-login migration checksum is invalid.",
  installedMismatch: "The installed OIDC-login schema does not match migration v13.",
  missingPrerequisite: "OIDC-login migration v13 requires durable storage migrations v1 through v12.",
  prerequisiteMismatch: "OIDC-login migration v13 requires exact durable storage migrations v1 through v12.",
  source: OIDC_LOGIN_MIGRATION_V13_SOURCE,
  version: 13,
});

const billingEntitlementMigrationV14: DurableStorageMigration<14> = Object.freeze({
  checksum: BILLING_ENTITLEMENT_MIGRATION_V14_CHECKSUM,
  checksumMismatch: "The billing-entitlement migration checksum is invalid.",
  installedMismatch: "The installed billing-entitlement schema does not match migration v14.",
  missingPrerequisite: "Billing-entitlement migration v14 requires durable storage migrations v1 through v13.",
  prerequisiteMismatch: "Billing-entitlement migration v14 requires exact durable storage migrations v1 through v13.",
  source: BILLING_ENTITLEMENT_MIGRATION_V14_SOURCE,
  version: 14,
});

const renderSessionUsageMigrationV15: DurableStorageMigration<15> = Object.freeze({
  checksum: RENDER_SESSION_USAGE_MIGRATION_V15_CHECKSUM,
  checksumMismatch: "The render-session usage migration checksum is invalid.",
  installedMismatch: "The installed render-session usage schema does not match migration v15.",
  missingPrerequisite: "Render-session usage migration v15 requires durable storage migrations v1 through v14.",
  prerequisiteMismatch: "Render-session usage migration v15 requires exact durable storage migrations v1 through v14.",
  source: RENDER_SESSION_USAGE_MIGRATION_V15_SOURCE,
  version: 15,
});

const stripeBillingMigrationV16: DurableStorageMigration<16> = Object.freeze({
  checksum: STRIPE_BILLING_MIGRATION_V16_CHECKSUM,
  checksumMismatch: "The Stripe billing migration checksum is invalid.",
  installedMismatch: "The installed Stripe billing schema does not match migration v16.",
  missingPrerequisite: "Stripe billing migration v16 requires durable storage migrations v1 through v15.",
  prerequisiteMismatch: "Stripe billing migration v16 requires exact durable storage migrations v1 through v15.",
  source: STRIPE_BILLING_MIGRATION_V16_SOURCE,
  version: 16,
});

const editorDocumentMigrationV17: DurableStorageMigration<17> = Object.freeze({
  checksum: EDITOR_DOCUMENT_MIGRATION_V17_CHECKSUM,
  checksumMismatch: "The editor-document migration checksum is invalid.",
  installedMismatch: "The installed editor-document schema does not match migration v17.",
  missingPrerequisite: "Editor-document migration v17 requires durable storage migrations v1 through v16.",
  prerequisiteMismatch: "Editor-document migration v17 requires exact durable storage migrations v1 through v16.",
  source: EDITOR_DOCUMENT_MIGRATION_V17_SOURCE,
  version: 17,
});

const editorMutationMigrationV18: DurableStorageMigration<18> = Object.freeze({
  checksum: EDITOR_MUTATION_MIGRATION_V18_CHECKSUM,
  checksumMismatch: "The editor-mutation migration checksum is invalid.",
  installedMismatch: "The installed editor-mutation schema does not match migration v18.",
  missingPrerequisite: "Editor-mutation migration v18 requires durable storage migrations v1 through v17.",
  prerequisiteMismatch: "Editor-mutation migration v18 requires exact durable storage migrations v1 through v17.",
  source: EDITOR_MUTATION_MIGRATION_V18_SOURCE,
  version: 18,
});

const renderSessionSceneNameMigrationV19: DurableStorageMigration<19> = Object.freeze({
  checksum: RENDER_SESSION_SCENE_NAME_MIGRATION_V19_CHECKSUM,
  checksumMismatch: "The render-session Scene-name migration checksum is invalid.",
  installedMismatch: "The installed render-session Scene-name schema does not match migration v19.",
  missingPrerequisite: "Render-session Scene-name migration v19 requires durable storage migrations v1 through v18.",
  prerequisiteMismatch:
    "Render-session Scene-name migration v19 requires exact durable storage migrations v1 through v18.",
  source: RENDER_SESSION_SCENE_NAME_MIGRATION_V19_SOURCE,
  version: 19,
});

const immutableObjectGenerationMigrationV20: DurableStorageMigration<20> = Object.freeze({
  checksum: IMMUTABLE_OBJECT_GENERATION_MIGRATION_V20_CHECKSUM,
  checksumMismatch: "The immutable object-generation migration checksum is invalid.",
  installedMismatch: "The installed immutable object-generation schema does not match migration v20.",
  missingPrerequisite: "Immutable object-generation migration v20 requires durable storage migrations v1 through v19.",
  prerequisiteMismatch:
    "Immutable object-generation migration v20 requires exact durable storage migrations v1 through v19.",
  source: IMMUTABLE_OBJECT_GENERATION_MIGRATION_V20_SOURCE,
  version: 20,
});

const renderArtifactTombstoneMigrationV21: DurableStorageMigration<21> = Object.freeze({
  checksum: RENDER_ARTIFACT_TOMBSTONE_MIGRATION_V21_CHECKSUM,
  checksumMismatch: "The render-artifact tombstone migration checksum is invalid.",
  installedMismatch: "The installed render-artifact tombstone schema does not match migration v21.",
  missingPrerequisite: "Render-artifact tombstone migration v21 requires durable storage migrations v1 through v20.",
  prerequisiteMismatch:
    "Render-artifact tombstone migration v21 requires exact durable storage migrations v1 through v20.",
  source: RENDER_ARTIFACT_TOMBSTONE_MIGRATION_V21_SOURCE,
  version: 21,
});

const accountInvitationMigrationV22: DurableStorageMigration<22> = Object.freeze({
  checksum: ACCOUNT_INVITATION_MIGRATION_V22_CHECKSUM,
  checksumMismatch: "The account-invitation migration checksum is invalid.",
  installedMismatch: "The installed account-invitation schema does not match migration v22.",
  missingPrerequisite: "Account-invitation migration v22 requires durable storage migrations v1 through v21.",
  prerequisiteMismatch: "Account-invitation migration v22 requires exact durable storage migrations v1 through v21.",
  source: ACCOUNT_INVITATION_MIGRATION_V22_SOURCE,
  version: 22,
});

const editorSessionSnapshotMigrationV23: DurableStorageMigration<23> = Object.freeze({
  checksum: EDITOR_SESSION_SNAPSHOT_MIGRATION_V23_CHECKSUM,
  checksumMismatch: "The editor-session snapshot migration checksum is invalid.",
  installedMismatch: "The installed editor-session snapshot schema does not match migration v23.",
  missingPrerequisite: "Editor-session snapshot migration v23 requires durable storage migrations v1 through v22.",
  prerequisiteMismatch:
    "Editor-session snapshot migration v23 requires exact durable storage migrations v1 through v22.",
  source: EDITOR_SESSION_SNAPSHOT_MIGRATION_V23_SOURCE,
  version: 23,
});

const accountInvitationQuotaMigrationV24: DurableStorageMigration<24> = Object.freeze({
  checksum: ACCOUNT_INVITATION_QUOTA_MIGRATION_V24_CHECKSUM,
  checksumMismatch: "The account-invitation quota migration checksum is invalid.",
  installedMismatch: "The installed account-invitation quota schema does not match migration v24.",
  missingPrerequisite: "Account-invitation quota migration v24 requires durable storage migrations v1 through v23.",
  prerequisiteMismatch:
    "Account-invitation quota migration v24 requires exact durable storage migrations v1 through v23.",
  source: ACCOUNT_INVITATION_QUOTA_MIGRATION_V24_SOURCE,
  version: 24,
});

const snapshotRuntimeConfigHeadMigrationV25: DurableStorageMigration<25> = Object.freeze({
  checksum: SNAPSHOT_RUNTIME_CONFIG_HEAD_MIGRATION_V25_CHECKSUM,
  checksumMismatch: "The snapshot runtime-config head migration checksum is invalid.",
  installedMismatch: "The installed snapshot runtime-config head schema does not match migration v25.",
  missingPrerequisite: "Snapshot runtime-config head migration v25 requires durable storage migrations v1 through v24.",
  prerequisiteMismatch:
    "Snapshot runtime-config head migration v25 requires exact durable storage migrations v1 through v24.",
  source: SNAPSHOT_RUNTIME_CONFIG_HEAD_MIGRATION_V25_SOURCE,
  version: 25,
});

const collaborationAuthorizationMigrationV26: DurableStorageMigration<26> = Object.freeze({
  checksum: COLLABORATION_AUTHORIZATION_MIGRATION_V26_CHECKSUM,
  checksumMismatch: "The collaboration-authorization migration checksum is invalid.",
  installedMismatch: "The installed collaboration-authorization schema does not match migration v26.",
  missingPrerequisite: "Collaboration-authorization migration v26 requires durable storage migrations v1 through v25.",
  prerequisiteMismatch:
    "Collaboration-authorization migration v26 requires exact durable storage migrations v1 through v25.",
  source: COLLABORATION_AUTHORIZATION_MIGRATION_V26_SOURCE,
  version: 26,
});

const snapshotPublicationTombstoneRetentionMigrationV27: DurableStorageMigration<27> = Object.freeze({
  checksum: SNAPSHOT_PUBLICATION_TOMBSTONE_RETENTION_MIGRATION_V27_CHECKSUM,
  checksumMismatch: "The snapshot-publication tombstone-retention migration checksum is invalid.",
  installedMismatch: "The installed snapshot-publication tombstone-retention schema does not match migration v27.",
  missingPrerequisite:
    "Snapshot-publication tombstone-retention migration v27 requires durable storage migrations v1 through v26.",
  prerequisiteMismatch:
    "Snapshot-publication tombstone-retention migration v27 requires exact durable storage migrations v1 through v26.",
  source: SNAPSHOT_PUBLICATION_TOMBSTONE_RETENTION_MIGRATION_V27_SOURCE,
  version: 27,
});

const accountOrganizationSwitchMutationMigrationV28: DurableStorageMigration<28> = Object.freeze({
  checksum: ACCOUNT_ORGANIZATION_SWITCH_MUTATION_MIGRATION_V28_CHECKSUM,
  checksumMismatch: "The account organization-switch mutation migration checksum is invalid.",
  installedMismatch: "The installed account organization-switch mutation schema does not match migration v28.",
  missingPrerequisite:
    "Account organization-switch mutation migration v28 requires durable storage migrations v1 through v27.",
  prerequisiteMismatch:
    "Account organization-switch mutation migration v28 requires exact durable storage migrations v1 through v27.",
  source: ACCOUNT_ORGANIZATION_SWITCH_MUTATION_MIGRATION_V28_SOURCE,
  version: 28,
});

const runtimeCellAssignmentMigrationV29: DurableStorageMigration<29> = Object.freeze({
  checksum: RUNTIME_CELL_ASSIGNMENT_MIGRATION_V29_CHECKSUM,
  checksumMismatch: "The runtime-cell assignment migration checksum is invalid.",
  installedMismatch: "The installed runtime-cell assignment schema does not match migration v29.",
  missingPrerequisite: "Runtime-cell assignment migration v29 requires durable storage migrations v1 through v28.",
  prerequisiteMismatch:
    "Runtime-cell assignment migration v29 requires exact durable storage migrations v1 through v28.",
  source: RUNTIME_CELL_ASSIGNMENT_MIGRATION_V29_SOURCE,
  version: 29,
});

const editorDocumentOriginMigrationV30: DurableStorageMigration<30> = Object.freeze({
  checksum: EDITOR_DOCUMENT_ORIGIN_MIGRATION_V30_CHECKSUM,
  checksumMismatch: "The editor document-origin migration checksum is invalid.",
  installedMismatch: "The installed editor document-origin schema does not match migration v30.",
  missingPrerequisite: "Editor document-origin migration v30 requires durable storage migrations v1 through v29.",
  prerequisiteMismatch:
    "Editor document-origin migration v30 requires exact durable storage migrations v1 through v29.",
  source: EDITOR_DOCUMENT_ORIGIN_MIGRATION_V30_SOURCE,
  version: 30,
});

const clientExportPublicationMigrationV31: DurableStorageMigration<31> = Object.freeze({
  checksum: CLIENT_EXPORT_PUBLICATION_MIGRATION_V31_CHECKSUM,
  checksumMismatch: "The client-export publication migration checksum is invalid.",
  installedMismatch: "The installed client-export publication schema does not match migration v31.",
  missingPrerequisite: "Client-export publication migration v31 requires durable storage migrations v1 through v30.",
  prerequisiteMismatch:
    "Client-export publication migration v31 requires exact durable storage migrations v1 through v30.",
  source: CLIENT_EXPORT_PUBLICATION_MIGRATION_V31_SOURCE,
  version: 31,
});

const billingEntitlementGrantMigrationV32: DurableStorageMigration<32> = Object.freeze({
  checksum: BILLING_ENTITLEMENT_GRANT_MIGRATION_V32_CHECKSUM,
  checksumMismatch: "The billing entitlement-grant migration checksum is invalid.",
  installedMismatch: "The installed billing entitlement-grant schema does not match migration v32.",
  missingPrerequisite: "Billing entitlement-grant migration v32 requires durable storage migrations v1 through v31.",
  prerequisiteMismatch:
    "Billing entitlement-grant migration v32 requires exact durable storage migrations v1 through v31.",
  source: BILLING_ENTITLEMENT_GRANT_MIGRATION_V32_SOURCE,
  version: 32,
});

const clientThumbnailPublicationMigrationV33: DurableStorageMigration<33> = Object.freeze({
  checksum: CLIENT_THUMBNAIL_PUBLICATION_MIGRATION_V33_CHECKSUM,
  checksumMismatch: "The client-thumbnail publication migration checksum is invalid.",
  installedMismatch: "The installed client-thumbnail publication schema does not match migration v33.",
  missingPrerequisite: "Client-thumbnail publication migration v33 requires durable storage migrations v1 through v32.",
  prerequisiteMismatch:
    "Client-thumbnail publication migration v33 requires exact durable storage migrations v1 through v32.",
  source: CLIENT_THUMBNAIL_PUBLICATION_MIGRATION_V33_SOURCE,
  version: 33,
});

const BUNDLED_DURABLE_STORAGE_MIGRATIONS = Object.freeze([
  workspaceSourceMigrationV1,
  renderSessionMigrationV2,
  snapshotPublicationMigrationV3,
  renderArtifactMigrationV4,
  projectPngMigrationV5,
  renderSessionRetentionMigrationV6,
  renderCancellationMigrationV7,
  renderSessionFailureMigrationV8,
  renderSessionCpuFailureMigrationV9,
  snapshotRuntimeDigestMigrationV10,
  accountOrganizationMigrationV11,
  accountSessionMigrationV12,
  oidcLoginMigrationV13,
  billingEntitlementMigrationV14,
  renderSessionUsageMigrationV15,
  stripeBillingMigrationV16,
  editorDocumentMigrationV17,
  editorMutationMigrationV18,
  renderSessionSceneNameMigrationV19,
  immutableObjectGenerationMigrationV20,
  renderArtifactTombstoneMigrationV21,
  accountInvitationMigrationV22,
  editorSessionSnapshotMigrationV23,
  accountInvitationQuotaMigrationV24,
  snapshotRuntimeConfigHeadMigrationV25,
  collaborationAuthorizationMigrationV26,
  snapshotPublicationTombstoneRetentionMigrationV27,
  accountOrganizationSwitchMutationMigrationV28,
  runtimeCellAssignmentMigrationV29,
  editorDocumentOriginMigrationV30,
  clientExportPublicationMigrationV31,
  billingEntitlementGrantMigrationV32,
  clientThumbnailPublicationMigrationV33,
]);

/**
 * Public, source-free view of the bundled catalog for operator tooling.
 * Keeping the checksum beside its version lets a dry-run reject a database
 * whose migration ledger does not match the artifact that is about to deploy.
 */
export const BUNDLED_DURABLE_STORAGE_MIGRATION_CATALOG_V1: readonly Readonly<{
  checksum: string;
  version: number;
}>[] = Object.freeze(
  BUNDLED_DURABLE_STORAGE_MIGRATIONS.map(({ checksum, version }) => Object.freeze({ checksum, version })),
);

const bundledDurableStorageMigrationHead = BUNDLED_DURABLE_STORAGE_MIGRATION_CATALOG_V1.at(-1);
if (!bundledDurableStorageMigrationHead) throw new Error("No durable storage migrations are bundled.");

/** Exact catalog head that operator and rollout tooling must derive from this artifact. */
export const BUNDLED_DURABLE_STORAGE_MIGRATION_HEAD_V1 = bundledDurableStorageMigrationHead.version;

function bundledMigrationsThrough(version: number) {
  const index = BUNDLED_DURABLE_STORAGE_MIGRATIONS.findIndex((migration) => migration.version === version);
  if (index < 0) throw new TypeError(`Durable storage migration v${version} is not bundled.`);
  return BUNDLED_DURABLE_STORAGE_MIGRATIONS.slice(0, index + 1);
}

function bundledMigrationsBefore(version: number) {
  return bundledMigrationsThrough(version).slice(0, -1);
}

function validateSource(migration: DurableStorageMigration) {
  if (durableStorageMigrationChecksum(migration.source) !== migration.checksum) {
    throw new TypeError(migration.checksumMismatch);
  }
}

async function applyMigration<Version extends number>(
  pool: Pool,
  migration: DurableStorageMigration<Version>,
  prerequisites: readonly DurableStorageMigration[],
) {
  validateSource(migration);
  const client = await pool.connect();
  let began = false;
  try {
    await client.query("BEGIN");
    began = true;
    await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [DURABLE_STORAGE_MIGRATION_LOCK]);
    const table = await client.query<{ relation: string | null }>(
      "SELECT to_regclass('public.poietra_schema_migrations')::text AS relation",
    );
    const relation = table.rows[0]?.relation;
    if (relation === undefined) throw new Error(migration.installedMismatch);
    if (relation === null && migration.version !== 1) {
      throw new Error(migration.missingPrerequisite);
    }

    if (relation !== null) {
      const installed = await client.query<{ checksum: string; version: number }>(
        "SELECT version, checksum FROM public.poietra_schema_migrations WHERE version <= $1 ORDER BY version",
        [migration.version],
      );
      for (const prerequisite of prerequisites) {
        const row = installed.rows.find(({ version }) => version === prerequisite.version);
        if (row?.checksum !== prerequisite.checksum) throw new Error(migration.prerequisiteMismatch);
      }
      const current = installed.rows.find(({ version }) => version === migration.version);
      if (current) {
        if (current.checksum !== migration.checksum) throw new Error(migration.installedMismatch);
        await client.query("COMMIT");
        began = false;
        return { applied: false, version: migration.version } as const;
      }
      if (migration.version === 1) throw new Error(migration.installedMismatch);
    }

    await client.query(migration.source);
    await client.query("INSERT INTO public.poietra_schema_migrations (version, checksum) VALUES ($1, $2)", [
      migration.version,
      migration.checksum,
    ]);
    await client.query("COMMIT");
    began = false;
    return { applied: true, version: migration.version } as const;
  } catch (error) {
    if (began) await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export function applyBundledWorkspaceSourceMigrationV1(pool: Pool) {
  return applyMigration(pool, workspaceSourceMigrationV1, []);
}

export function applyWorkspaceSourceMigrationV1(pool: Pool, source: string) {
  return applyMigration(pool, { ...workspaceSourceMigrationV1, source }, []);
}

export function applyRenderSessionMigrationV2(pool: Pool, source: string) {
  return applyMigration(pool, { ...renderSessionMigrationV2, source }, [workspaceSourceMigrationV1]);
}

export function applySnapshotPublicationMigrationV3(pool: Pool, source: string) {
  return applyMigration(pool, { ...snapshotPublicationMigrationV3, source }, [
    workspaceSourceMigrationV1,
    renderSessionMigrationV2,
  ]);
}

export function applyRenderArtifactMigrationV4(pool: Pool, source: string) {
  return applyMigration(pool, { ...renderArtifactMigrationV4, source }, [
    workspaceSourceMigrationV1,
    renderSessionMigrationV2,
    snapshotPublicationMigrationV3,
  ]);
}

export function applyProjectPngMigrationV5(pool: Pool, source: string) {
  return applyMigration(pool, { ...projectPngMigrationV5, source }, [
    workspaceSourceMigrationV1,
    renderSessionMigrationV2,
    snapshotPublicationMigrationV3,
    renderArtifactMigrationV4,
  ]);
}

export function applyRenderSessionRetentionMigrationV6(pool: Pool, source: string) {
  return applyMigration(pool, { ...renderSessionRetentionMigrationV6, source }, [
    workspaceSourceMigrationV1,
    renderSessionMigrationV2,
    snapshotPublicationMigrationV3,
    renderArtifactMigrationV4,
    projectPngMigrationV5,
  ]);
}

export function applyRenderCancellationMigrationV7(pool: Pool, source: string) {
  return applyMigration(pool, { ...renderCancellationMigrationV7, source }, [
    workspaceSourceMigrationV1,
    renderSessionMigrationV2,
    snapshotPublicationMigrationV3,
    renderArtifactMigrationV4,
    projectPngMigrationV5,
    renderSessionRetentionMigrationV6,
  ]);
}

export function applyRenderSessionFailureMigrationV8(pool: Pool, source: string) {
  return applyMigration(pool, { ...renderSessionFailureMigrationV8, source }, [
    workspaceSourceMigrationV1,
    renderSessionMigrationV2,
    snapshotPublicationMigrationV3,
    renderArtifactMigrationV4,
    projectPngMigrationV5,
    renderSessionRetentionMigrationV6,
    renderCancellationMigrationV7,
  ]);
}

export function applyRenderSessionCpuFailureMigrationV9(pool: Pool, source: string) {
  return applyMigration(pool, { ...renderSessionCpuFailureMigrationV9, source }, [
    workspaceSourceMigrationV1,
    renderSessionMigrationV2,
    snapshotPublicationMigrationV3,
    renderArtifactMigrationV4,
    projectPngMigrationV5,
    renderSessionRetentionMigrationV6,
    renderCancellationMigrationV7,
    renderSessionFailureMigrationV8,
  ]);
}

export function applySnapshotRuntimeDigestMigrationV10(pool: Pool, source: string) {
  return applyMigration(pool, { ...snapshotRuntimeDigestMigrationV10, source }, [
    workspaceSourceMigrationV1,
    renderSessionMigrationV2,
    snapshotPublicationMigrationV3,
    renderArtifactMigrationV4,
    projectPngMigrationV5,
    renderSessionRetentionMigrationV6,
    renderCancellationMigrationV7,
    renderSessionFailureMigrationV8,
    renderSessionCpuFailureMigrationV9,
  ]);
}

export function applyAccountOrganizationMigrationV11(pool: Pool, source: string) {
  return applyMigration(pool, { ...accountOrganizationMigrationV11, source }, [
    workspaceSourceMigrationV1,
    renderSessionMigrationV2,
    snapshotPublicationMigrationV3,
    renderArtifactMigrationV4,
    projectPngMigrationV5,
    renderSessionRetentionMigrationV6,
    renderCancellationMigrationV7,
    renderSessionFailureMigrationV8,
    renderSessionCpuFailureMigrationV9,
    snapshotRuntimeDigestMigrationV10,
  ]);
}

export function applyAccountSessionMigrationV12(pool: Pool, source: string) {
  return applyMigration(pool, { ...accountSessionMigrationV12, source }, [
    workspaceSourceMigrationV1,
    renderSessionMigrationV2,
    snapshotPublicationMigrationV3,
    renderArtifactMigrationV4,
    projectPngMigrationV5,
    renderSessionRetentionMigrationV6,
    renderCancellationMigrationV7,
    renderSessionFailureMigrationV8,
    renderSessionCpuFailureMigrationV9,
    snapshotRuntimeDigestMigrationV10,
    accountOrganizationMigrationV11,
  ]);
}

export function applyOidcLoginMigrationV13(pool: Pool, source: string) {
  return applyMigration(pool, { ...oidcLoginMigrationV13, source }, [
    workspaceSourceMigrationV1,
    renderSessionMigrationV2,
    snapshotPublicationMigrationV3,
    renderArtifactMigrationV4,
    projectPngMigrationV5,
    renderSessionRetentionMigrationV6,
    renderCancellationMigrationV7,
    renderSessionFailureMigrationV8,
    renderSessionCpuFailureMigrationV9,
    snapshotRuntimeDigestMigrationV10,
    accountOrganizationMigrationV11,
    accountSessionMigrationV12,
  ]);
}

export function applyEditorDocumentMigrationV17(pool: Pool, source: string) {
  return applyMigration(pool, { ...editorDocumentMigrationV17, source }, bundledMigrationsBefore(17));
}

export function applyEditorMutationMigrationV18(pool: Pool, source: string) {
  return applyMigration(pool, { ...editorMutationMigrationV18, source }, bundledMigrationsBefore(18));
}

export function applyRenderSessionSceneNameMigrationV19(pool: Pool, source: string) {
  return applyMigration(pool, { ...renderSessionSceneNameMigrationV19, source }, bundledMigrationsBefore(19));
}

export function applyImmutableObjectGenerationMigrationV20(pool: Pool, source: string) {
  return applyMigration(pool, { ...immutableObjectGenerationMigrationV20, source }, bundledMigrationsBefore(20));
}

export function applyRenderArtifactTombstoneMigrationV21(pool: Pool, source: string) {
  return applyMigration(pool, { ...renderArtifactTombstoneMigrationV21, source }, bundledMigrationsBefore(21));
}

export function applyAccountInvitationMigrationV22(pool: Pool, source: string) {
  return applyMigration(pool, { ...accountInvitationMigrationV22, source }, bundledMigrationsBefore(22));
}

export function applyEditorSessionSnapshotMigrationV23(pool: Pool, source: string) {
  return applyMigration(pool, { ...editorSessionSnapshotMigrationV23, source }, bundledMigrationsBefore(23));
}

export function applyAccountInvitationQuotaMigrationV24(pool: Pool, source: string) {
  return applyMigration(pool, { ...accountInvitationQuotaMigrationV24, source }, bundledMigrationsBefore(24));
}

export function applySnapshotRuntimeConfigHeadMigrationV25(pool: Pool, source: string) {
  return applyMigration(pool, { ...snapshotRuntimeConfigHeadMigrationV25, source }, bundledMigrationsBefore(25));
}

export function applyCollaborationAuthorizationMigrationV26(pool: Pool, source: string) {
  return applyMigration(pool, { ...collaborationAuthorizationMigrationV26, source }, bundledMigrationsBefore(26));
}

export function applySnapshotPublicationTombstoneRetentionMigrationV27(pool: Pool, source: string) {
  return applyMigration(
    pool,
    { ...snapshotPublicationTombstoneRetentionMigrationV27, source },
    bundledMigrationsBefore(27),
  );
}

export function applyAccountOrganizationSwitchMutationMigrationV28(pool: Pool, source: string) {
  return applyMigration(
    pool,
    { ...accountOrganizationSwitchMutationMigrationV28, source },
    bundledMigrationsBefore(28),
  );
}

export function applyRuntimeCellAssignmentMigrationV29(pool: Pool, source: string) {
  return applyMigration(pool, { ...runtimeCellAssignmentMigrationV29, source }, bundledMigrationsBefore(29));
}

export function applyEditorDocumentOriginMigrationV30(pool: Pool, source: string) {
  return applyMigration(pool, { ...editorDocumentOriginMigrationV30, source }, bundledMigrationsBefore(30));
}

export function applyClientExportPublicationMigrationV31(pool: Pool, source: string) {
  return applyMigration(pool, { ...clientExportPublicationMigrationV31, source }, bundledMigrationsBefore(31));
}

export function applyBillingEntitlementGrantMigrationV32(pool: Pool, source: string) {
  return applyMigration(pool, { ...billingEntitlementGrantMigrationV32, source }, bundledMigrationsBefore(32));
}

export function applyClientThumbnailPublicationMigrationV33(pool: Pool, source: string) {
  return applyMigration(pool, { ...clientThumbnailPublicationMigrationV33, source }, bundledMigrationsBefore(33));
}

/** Apply bundled migrations in order through one exact, validated catalog version. */
export async function applyBundledDurableStorageMigrationsThrough(pool: Pool, version: number) {
  const migrations = bundledMigrationsThrough(version);
  let result: Readonly<{ applied: boolean; version: number }> | undefined;
  for (const [index, migration] of migrations.entries()) {
    result = await applyMigration(pool, migration, migrations.slice(0, index));
  }
  if (!result) throw new Error("No durable storage migrations are bundled.");
  return result;
}

/** Apply every bundled migration in version order without encoding the count in the public API. */
export async function applyBundledDurableStorageMigrations(pool: Pool) {
  const latest = BUNDLED_DURABLE_STORAGE_MIGRATIONS.at(-1);
  if (!latest) throw new Error("No durable storage migrations are bundled.");
  return applyBundledDurableStorageMigrationsThrough(pool, latest.version);
}

/** @deprecated Use applyBundledDurableStorageMigrations. */
export async function applyBundledDurableStorageMigrationsV2(pool: Pool) {
  await applyMigration(pool, workspaceSourceMigrationV1, []);
  return applyMigration(pool, renderSessionMigrationV2, [workspaceSourceMigrationV1]);
}
