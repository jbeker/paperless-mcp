export const MATCHING_ALGORITHM_OPTIONS = {
  0: "None",
  1: "Any word",
  2: "All words",
  3: "Exact match",
  4: "Regular expression",
  5: "Fuzzy word",
  6: "Automatic",
} as const;

export type MatchingAlgorithm = keyof typeof MATCHING_ALGORITHM_OPTIONS;

export const MATCHING_ALGORITHM_DESCRIPTION = `Matching algorithm: ${Object.entries(
  MATCHING_ALGORITHM_OPTIONS
)
  .map(([id, name]) => `${id}=${name}`)
  .join(", ")}`;

export interface Tag {
  id: number;
  slug: string;
  name: string;
  color: string;
  text_color: string;
  match: string;
  matching_algorithm: MatchingAlgorithm;
  is_insensitive: boolean;
  is_inbox_tag: boolean;
  document_count: number;
  owner: number | null;
  user_can_change: boolean;
}

export interface CustomField {
  id: number;
  name: string;
  data_type: string;
  extra_data?: Record<string, unknown> | null;
  document_count: number;
}

export type CustomFieldValue = string | number | boolean | number[] | null;

export interface CustomFieldInstance {
  field: number;
  value: CustomFieldValue;
}

export interface CustomFieldInstanceRequest {
  field: number;
  value: CustomFieldValue;
}

export interface PaginationResponse<T> {
  count: number;
  next: string | null;
  previous: string | null;
  all: number[];
  results: T[];
}

export interface GetTagsResponse extends PaginationResponse<Tag> {}

export interface GetCustomFieldsResponse
  extends PaginationResponse<CustomField> {}

export interface BasicUser {
  id: number;
  username: string;
  first_name?: string;
  last_name?: string;
}

export interface Note {
  id: number;
  note: string;
  created: string;
  user: BasicUser;
}

export interface DocumentsResponse extends PaginationResponse<Document> {}

export interface Document {
  id: number;
  correspondent: number | null;
  document_type: number | null;
  storage_path: number | null;
  title: string;
  content: string | null;
  tags: number[];
  created: string;
  created_date: string;
  modified: string;
  added: string;
  deleted_at: string | null;
  archive_serial_number: string | null;
  original_file_name: string;
  archived_file_name: string;
  owner: number | null;
  user_can_change: boolean;
  is_shared_by_requester: boolean;
  notes: Note[];
  custom_fields: CustomFieldInstance[];
  page_count: number;
  mime_type: string;
  __search_hit__?: SearchHit;
}

export interface SearchHit {
  score: number;
  highlights: string;
  note_highlights: string;
  rank: number;
}

export interface Correspondent {
  id: number;
  slug: string;
  name: string;
  match: string;
  matching_algorithm: MatchingAlgorithm;
  is_insensitive: boolean;
  document_count: number;
  last_correspondence: string;
  owner: number | null;
  permissions: Record<string, unknown>;
  user_can_change: boolean;
}

export interface GetCorrespondentsResponse
  extends PaginationResponse<Correspondent> {}

export interface DocumentType {
  id: number;
  slug: string;
  name: string;
  match: string;
  matching_algorithm: MatchingAlgorithm;
  is_insensitive: boolean;
  document_count: number;
  last_correspondence: string;
  owner: number | null;
  permissions: Record<string, unknown>;
  user_can_change: boolean;
}

export interface GetDocumentTypesResponse
  extends PaginationResponse<DocumentType> {}

export interface MailAccount {
  id: number;
  name: string;
  imap_server: string;
  imap_port: number | null;
  imap_security: number;
  username: string;
  password?: string;
  character_set: string;
  is_token: boolean;
  owner: number | null;
  user_can_change: boolean;
  account_type: number;
  expiration: string | null;
}

export interface GetMailAccountsResponse
  extends PaginationResponse<MailAccount> {}

export interface MailRule {
  id: number;
  name: string;
  account: number;
  enabled: boolean;
  folder: string;
  filter_from: string | null;
  filter_to: string | null;
  filter_subject: string | null;
  filter_body: string | null;
  filter_attachment_filename_include: string | null;
  filter_attachment_filename_exclude: string | null;
  maximum_age: number;
  action: number;
  action_parameter: string | null;
  assign_title_from: number;
  assign_tags: Array<number | null>;
  assign_correspondent_from: number;
  assign_correspondent: number | null;
  assign_document_type: number | null;
  assign_owner_from_rule: boolean;
  order: number;
  attachment_type: number;
  consumption_scope: number;
  pdf_layout: number;
  owner: number | null;
  user_can_change: boolean;
}

export interface GetMailRulesResponse extends PaginationResponse<MailRule> {}

export interface User {
  id: number;
  username: string;
  email?: string;
  first_name?: string;
  last_name?: string;
  date_joined?: string;
  is_staff?: boolean;
  is_active?: boolean;
  is_superuser?: boolean;
  groups?: number[];
  user_permissions?: string[];
  inherited_permissions: string[];
  is_mfa_enabled: boolean;
}

export interface GetUsersResponse extends PaginationResponse<User> {}

export interface Group {
  id: number;
  name: string;
  permissions: string[];
}

export interface GetGroupsResponse extends PaginationResponse<Group> {}

export interface StoragePath {
  id: number;
  slug: string;
  name: string;
  path: string;
  match: string;
  matching_algorithm: MatchingAlgorithm;
  is_insensitive: boolean;
  document_count: number;
  owner: number | null;
  user_can_change: boolean;
}

export interface GetStoragePathsResponse
  extends PaginationResponse<StoragePath> {}

/**
 * The OpenAPI spec types /api/ui_settings/ as only {id, settings}, but live
 * Paperless-NGX servers include the logged-in user object. Model it as
 * optional and handle its absence.
 */
export interface UiSettingsUser {
  id: number;
  username: string;
  first_name?: string;
  last_name?: string;
  is_staff?: boolean;
  is_superuser?: boolean;
  groups?: number[];
}

export interface UiSettingsResponse {
  user?: UiSettingsUser;
  settings?: Record<string, unknown> | null;
  permissions?: string[];
}

export interface Profile {
  email?: string;
  first_name?: string;
  last_name?: string;
  is_mfa_enabled?: boolean;
  has_usable_password?: boolean;
}

export interface DocumentSuggestions {
  correspondents: number[];
  tags: number[];
  document_types: number[];
  storage_paths: number[];
  dates: string[];
}

export interface DocumentMetadata {
  original_checksum: string;
  original_size: number;
  original_mime_type: string;
  media_filename: string;
  has_archive_version: boolean;
  original_metadata: Record<string, unknown>;
  archive_checksum: string;
  archive_media_filename: string;
  original_filename: string;
  archive_size: number;
  archive_metadata: Record<string, unknown>;
  lang: string;
}

export type TaskStatus =
  | "FAILURE"
  | "PENDING"
  | "RECEIVED"
  | "RETRY"
  | "REVOKED"
  | "STARTED"
  | "SUCCESS";

export interface PaperlessTask {
  id: number;
  task_id: string;
  task_name:
    | "check_sanity"
    | "consume_file"
    | "index_optimize"
    | "train_classifier"
    | null;
  task_file_name: string | null;
  date_created: string | null;
  date_done: string | null;
  type: "auto_task" | "scheduled_task" | "manual_task";
  status: TaskStatus;
  result: string | null;
  acknowledged: boolean;
  related_document: string | null;
  owner: number | null;
}

export interface AcknowledgeTasksResult {
  result: number;
}

export interface SystemStatus {
  pngx_version: string;
  server_os: string;
  install_type: string;
  storage: Record<string, unknown>;
  database: Record<string, unknown>;
  tasks: Record<string, unknown>;
  index: Record<string, unknown>;
  classifier: Record<string, unknown>;
  sanity_check: Record<string, unknown>;
}

export interface TrashRequest {
  documents?: number[];
  action: "restore" | "empty";
}

export interface WorkflowEmail {
  id?: number | null;
  subject: string;
  body: string;
  to: string;
  include_document?: boolean;
}

export interface WorkflowWebhook {
  id?: number | null;
  url: string;
  use_params?: boolean;
  as_json?: boolean;
  params?: unknown;
  body?: string | null;
  headers?: unknown;
  include_document?: boolean;
}

export interface WorkflowTrigger {
  id?: number | null;
  sources?: number[];
  type: number;
  filter_path?: string | null;
  filter_filename?: string | null;
  filter_mailrule?: number | null;
  matching_algorithm?: number;
  match?: string;
  is_insensitive?: boolean;
  filter_has_tags?: number[];
  filter_has_all_tags?: number[];
  filter_has_not_tags?: number[];
  filter_custom_field_query?: string | null;
  filter_has_not_correspondents?: number[];
  filter_has_not_document_types?: number[];
  filter_has_not_storage_paths?: number[];
  filter_has_correspondent?: number | null;
  filter_has_document_type?: number | null;
  filter_has_storage_path?: number | null;
  schedule_offset_days?: number;
  schedule_is_recurring?: boolean;
  schedule_recurring_interval_days?: number;
  schedule_date_field?: "added" | "created" | "modified" | "custom_field";
  schedule_date_custom_field?: number | null;
}

export interface WorkflowAction {
  id?: number | null;
  type?: number;
  assign_title?: string | null;
  assign_tags?: Array<number | null>;
  assign_correspondent?: number | null;
  assign_document_type?: number | null;
  assign_storage_path?: number | null;
  assign_owner?: number | null;
  assign_view_users?: number[];
  assign_view_groups?: number[];
  assign_change_users?: number[];
  assign_change_groups?: number[];
  assign_custom_fields?: number[];
  assign_custom_fields_values?: Record<string, unknown> | null;
  remove_all_tags?: boolean;
  remove_tags?: number[];
  remove_all_correspondents?: boolean;
  remove_correspondents?: number[];
  remove_all_document_types?: boolean;
  remove_document_types?: number[];
  remove_all_storage_paths?: boolean;
  remove_storage_paths?: number[];
  remove_custom_fields?: number[];
  remove_all_custom_fields?: boolean;
  remove_all_owners?: boolean;
  remove_owners?: number[];
  remove_all_permissions?: boolean;
  remove_view_users?: number[];
  remove_view_groups?: number[];
  remove_change_users?: number[];
  remove_change_groups?: number[];
  email?: WorkflowEmail | null;
  webhook?: WorkflowWebhook | null;
}

export interface Workflow {
  id: number;
  name: string;
  order?: number;
  enabled?: boolean;
  triggers: WorkflowTrigger[];
  actions: WorkflowAction[];
}

export interface WorkflowRequest {
  name: string;
  order?: number;
  enabled?: boolean;
  triggers: WorkflowTrigger[];
  actions: WorkflowAction[];
}

export interface GetWorkflowsResponse extends PaginationResponse<Workflow> {}

export interface BulkEditDocumentsResult {
  result: string;
}

export interface BulkEditParameters {
  add_custom_fields?: Record<string, CustomFieldInstanceRequest["value"]>;
  remove_custom_fields?: number[];
  add_tags?: number[];
  remove_tags?: number[];
  degrees?: number;
  pages?: string;
  metadata_document_id?: number;
  delete_originals?: boolean;
  correspondent?: number;
  document_type?: number;
  storage_path?: number;
  tag?: number;
  permissions?: {
    owner?: number | null;
    set_permissions?: {
      view: { users: number[]; groups: number[] };
      change: { users: number[]; groups: number[] };
    };
    merge?: boolean;
  };
}

export interface MintUploadRequest {
  title?: string;
  correspondent?: number;
  document_type?: number;
  tags?: number[];
  created?: string;
  max_bytes?: number;
  ttl_seconds?: number;
}

export interface MintUploadResponse {
  upload_url: string;
  expires_at: string;
  max_bytes: number;
  curl_example: string;
}
