import { env } from "cloudflare:workers";

export type RuntimeEnv = { DB: D1Database; FILES?: R2Bucket; SEO_JOBS?: Queue; SEO_APP?: Fetcher; CREDENTIALS_ENCRYPTION_KEY?: string; GOOGLE_OAUTH_CLIENT_ID?: string; GOOGLE_OAUTH_CLIENT_SECRET?: string; GOOGLE_OAUTH_REDIRECT_URI?: string; ANTHROPIC_API_KEY?: string; OPENAI_API_KEY?: string; SEO_LOOP_ORIGIN?: string; SEO_LOOP_WORKER_TOKEN?: string; META_GRAPH_VERSION?: string; CLOUD_RUNNER_URL?: string; CLOUD_RUNNER_PUBLIC_URL?: string; CLOUD_DISPATCH_TOKEN?: string; PUBLIC_NO_LOGIN?: string; APP_OWNER_ID?: string };
export const runtime = () => env as unknown as RuntimeEnv;
export const now = () => new Date().toISOString();
export const id = () => crypto.randomUUID();
export const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });

export function ownerId(request: Request) {
  // PUBLIC_NO_LOGIN is intentionally single-owner only. The owner comes from
  // a Worker Secret, never from a browser header, query string, or request
  // body. Multi-owner use must reinstate authenticated authorization.
  if (runtime().PUBLIC_NO_LOGIN === "true") return runtime().APP_OWNER_ID?.trim() || "";

  // Local development remains usable without a production secret.
  const host = new URL(request.url).hostname;
  return host === "localhost" || host === "127.0.0.1" ? "local-development-user" : "";
}

const schema = [
  "CREATE TABLE IF NOT EXISTS clients (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, name TEXT NOT NULL, site TEXT NOT NULL DEFAULT '', niche TEXT NOT NULL DEFAULT '', primary_info_status TEXT NOT NULL DEFAULT 'missing', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
  "CREATE INDEX IF NOT EXISTS idx_clients_owner ON clients(owner_id)",
  "CREATE TABLE IF NOT EXISTS connections (id TEXT PRIMARY KEY, client_id TEXT NOT NULL, connector TEXT NOT NULL, status TEXT NOT NULL, public_config TEXT NOT NULL DEFAULT '{}', secret_cipher TEXT, checked_at TEXT, updated_at TEXT NOT NULL)",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_connections_client_connector ON connections(client_id, connector)",
  "CREATE TABLE IF NOT EXISTS sources (id TEXT PRIMARY KEY, client_id TEXT NOT NULL, type TEXT NOT NULL, title TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', url TEXT NOT NULL DEFAULT '', rights TEXT NOT NULL DEFAULT 'unconfirmed', approved INTEGER NOT NULL DEFAULT 0, is_canonical INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0, canonical_status TEXT NOT NULL DEFAULT 'candidate', created_at TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT '')",
  "CREATE INDEX IF NOT EXISTS idx_sources_client ON sources(client_id)",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_sources_one_canonical ON sources(client_id) WHERE is_canonical=1",
  "CREATE TABLE IF NOT EXISTS primary_info_versions (id TEXT PRIMARY KEY, client_id TEXT NOT NULL, source_id TEXT NOT NULL, version_no INTEGER NOT NULL, article_ready_text TEXT NOT NULL, interview_json TEXT NOT NULL DEFAULT '[]', change_summary TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL)",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_primary_info_version_once ON primary_info_versions(source_id,version_no)",
  "CREATE INDEX IF NOT EXISTS idx_primary_info_versions_client ON primary_info_versions(client_id,created_at DESC)",
  "CREATE TABLE IF NOT EXISTS source_files (id TEXT PRIMARY KEY, client_id TEXT NOT NULL, object_key TEXT NOT NULL, name TEXT NOT NULL, content_type TEXT NOT NULL, size INTEGER NOT NULL, rights_confirmed INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'uploaded', created_at TEXT NOT NULL)",
  "CREATE INDEX IF NOT EXISTS idx_source_files_client_created ON source_files(client_id, created_at)",
  "CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, client_id TEXT NOT NULL, type TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}', result TEXT, attempts INTEGER NOT NULL DEFAULT 0, lease_until TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
  "CREATE INDEX IF NOT EXISTS idx_jobs_status_created ON jobs(status, created_at)",
  "CREATE INDEX IF NOT EXISTS idx_jobs_client ON jobs(client_id)",
  "CREATE TABLE IF NOT EXISTS snapshots (id TEXT PRIMARY KEY, client_id TEXT NOT NULL, connector TEXT NOT NULL, data TEXT NOT NULL, retrieved_at TEXT NOT NULL)",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_snapshots_client_connector ON snapshots(client_id, connector)",
  "CREATE TABLE IF NOT EXISTS logs (id TEXT PRIMARY KEY, client_id TEXT NOT NULL, level TEXT NOT NULL DEFAULT 'info', message TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL)",
  "CREATE INDEX IF NOT EXISTS idx_logs_client_created ON logs(client_id, created_at)",
  "CREATE TABLE IF NOT EXISTS worker_tokens (id TEXT PRIMARY KEY, client_id TEXT NOT NULL, token_hash TEXT NOT NULL, name TEXT NOT NULL, last_seen_at TEXT, created_at TEXT NOT NULL)",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_worker_token_hash ON worker_tokens(token_hash)",
  "CREATE TABLE IF NOT EXISTS oauth_states (state TEXT PRIMARY KEY, client_id TEXT NOT NULL, owner_id TEXT NOT NULL, expires_at TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS external_oauth_states (state TEXT PRIMARY KEY, client_id TEXT NOT NULL, owner_id TEXT NOT NULL, provider TEXT NOT NULL, secret_cipher TEXT NOT NULL, expires_at TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS app_settings (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, setting_key TEXT NOT NULL, public_config TEXT NOT NULL DEFAULT '{}', secret_cipher TEXT NOT NULL, updated_at TEXT NOT NULL)",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_app_settings_owner_key ON app_settings(owner_id, setting_key)"
  ,"CREATE TABLE IF NOT EXISTS topics (id TEXT PRIMARY KEY, client_id TEXT NOT NULL, parent_topic_id TEXT, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'active', coverage_score REAL NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)"
  ,"CREATE UNIQUE INDEX IF NOT EXISTS idx_topics_client_name ON topics(client_id,name)"
  ,"CREATE INDEX IF NOT EXISTS idx_topics_client_parent ON topics(client_id,parent_topic_id)"
  ,"CREATE TABLE IF NOT EXISTS keyword_clusters (id TEXT PRIMARY KEY, client_id TEXT NOT NULL, topic_id TEXT, parent_cluster_id TEXT, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'active', coverage_score REAL NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)"
  ,"CREATE UNIQUE INDEX IF NOT EXISTS idx_keyword_clusters_client_name ON keyword_clusters(client_id,name)"
  ,"CREATE INDEX IF NOT EXISTS idx_keyword_clusters_topic ON keyword_clusters(client_id,topic_id)"
  ,"CREATE TABLE IF NOT EXISTS seo_keywords (id TEXT PRIMARY KEY, client_id TEXT NOT NULL, topic_id TEXT, cluster_id TEXT, keyword TEXT NOT NULL, normalized_keyword TEXT NOT NULL, primary_or_secondary TEXT NOT NULL DEFAULT 'primary', search_intent TEXT NOT NULL DEFAULT 'unknown', search_volume REAL, keyword_difficulty REAL, cpc REAL, current_position REAL, impressions REAL, clicks REAL, ctr REAL, business_relevance REAL, conversion_potential REAL, topical_relevance REAL, ranking_opportunity REAL, priority_score REAL NOT NULL DEFAULT 0, source TEXT NOT NULL DEFAULT 'manual', status TEXT NOT NULL DEFAULT 'candidate', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)"
  ,"CREATE UNIQUE INDEX IF NOT EXISTS idx_seo_keywords_client_normalized ON seo_keywords(client_id,normalized_keyword)"
  ,"CREATE INDEX IF NOT EXISTS idx_seo_keywords_client_priority ON seo_keywords(client_id,priority_score DESC)"
  ,"CREATE TABLE IF NOT EXISTS keyword_article_relations (id TEXT PRIMARY KEY, keyword_id TEXT NOT NULL, article_id TEXT NOT NULL, relation_type TEXT NOT NULL DEFAULT 'primary', confidence REAL NOT NULL DEFAULT 0, created_at TEXT NOT NULL)"
  ,"CREATE UNIQUE INDEX IF NOT EXISTS idx_keyword_article_relation_unique ON keyword_article_relations(keyword_id,article_id,relation_type)"
  ,"CREATE INDEX IF NOT EXISTS idx_keyword_article_relations_article ON keyword_article_relations(article_id)"
  ,"CREATE TABLE IF NOT EXISTS content_briefs (id TEXT PRIMARY KEY, client_id TEXT NOT NULL, keyword_id TEXT, search_intent TEXT NOT NULL DEFAULT 'unknown', target_user TEXT NOT NULL DEFAULT '', explicit_need TEXT NOT NULL DEFAULT '', latent_need TEXT NOT NULL DEFAULT '', anxiety TEXT NOT NULL DEFAULT '', comparison_axes TEXT NOT NULL DEFAULT '[]', desired_outcome TEXT NOT NULL DEFAULT '', funnel_stage TEXT NOT NULL DEFAULT '', serp_consensus TEXT NOT NULL DEFAULT '[]', required_topics TEXT NOT NULL DEFAULT '[]', content_gap TEXT NOT NULL DEFAULT '', differentiation TEXT NOT NULL DEFAULT '', primary_sources TEXT NOT NULL DEFAULT '[]', internal_link_candidates TEXT NOT NULL DEFAULT '[]', cta TEXT NOT NULL DEFAULT '', ymyl_risk TEXT NOT NULL DEFAULT 'low', eeat_requirements TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'draft', version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)"
  ,"CREATE INDEX IF NOT EXISTS idx_content_briefs_client_keyword ON content_briefs(client_id,keyword_id,updated_at DESC)"
  ,"CREATE TABLE IF NOT EXISTS gsc_search_performance (id TEXT PRIMARY KEY, client_id TEXT NOT NULL, date TEXT NOT NULL, query TEXT NOT NULL, page TEXT NOT NULL, clicks REAL NOT NULL DEFAULT 0, impressions REAL NOT NULL DEFAULT 0, ctr REAL NOT NULL DEFAULT 0, position REAL, created_at TEXT NOT NULL)"
  ,"CREATE UNIQUE INDEX IF NOT EXISTS idx_gsc_performance_unique ON gsc_search_performance(client_id,date,query,page)"
  ,"CREATE INDEX IF NOT EXISTS idx_gsc_performance_client_date ON gsc_search_performance(client_id,date DESC)"
  ,"CREATE TABLE IF NOT EXISTS ga4_page_performance (id TEXT PRIMARY KEY, client_id TEXT NOT NULL, date TEXT NOT NULL, landing_page TEXT NOT NULL, source TEXT NOT NULL DEFAULT '(not set)', medium TEXT NOT NULL DEFAULT '(not set)', sessions REAL NOT NULL DEFAULT 0, organic_sessions REAL NOT NULL DEFAULT 0, engaged_sessions REAL NOT NULL DEFAULT 0, engagement_rate REAL, conversions REAL NOT NULL DEFAULT 0, revenue REAL NOT NULL DEFAULT 0, created_at TEXT NOT NULL)"
  ,"CREATE UNIQUE INDEX IF NOT EXISTS idx_ga4_performance_unique ON ga4_page_performance(client_id,date,landing_page,source,medium)"
  ,"CREATE INDEX IF NOT EXISTS idx_ga4_performance_client_date ON ga4_page_performance(client_id,date DESC)"
  ,"CREATE TABLE IF NOT EXISTS seo_actions (id TEXT PRIMARY KEY, client_id TEXT NOT NULL, article_id TEXT, keyword_id TEXT, action_type TEXT NOT NULL, hypothesis TEXT NOT NULL DEFAULT '', reason TEXT NOT NULL DEFAULT '', source_data TEXT NOT NULL DEFAULT '{}', action_taken TEXT NOT NULL DEFAULT '', target_kpi TEXT NOT NULL DEFAULT '', before_value TEXT NOT NULL DEFAULT '{}', after_value TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'planned', executed_at TEXT, measured_at TEXT, created_at TEXT NOT NULL)"
  ,"CREATE INDEX IF NOT EXISTS idx_seo_actions_client_created ON seo_actions(client_id,created_at DESC)"
  ,"CREATE TABLE IF NOT EXISTS article_mapping_candidates (id TEXT PRIMARY KEY,client_id TEXT NOT NULL,article_id TEXT NOT NULL,article_title TEXT NOT NULL DEFAULT '',article_url TEXT NOT NULL DEFAULT '',current_topic_id TEXT,current_cluster_id TEXT,current_keyword_id TEXT,suggested_topic_id TEXT,suggested_cluster_id TEXT,suggested_keyword_id TEXT,suggested_keyword_text TEXT NOT NULL DEFAULT '',confidence REAL NOT NULL DEFAULT 0,reasoning TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT 'PENDING',created_at TEXT NOT NULL,updated_at TEXT NOT NULL)"
  ,"CREATE UNIQUE INDEX IF NOT EXISTS idx_mapping_candidate_client_article ON article_mapping_candidates(client_id,article_id)"
  ,"CREATE INDEX IF NOT EXISTS idx_mapping_candidate_client_status ON article_mapping_candidates(client_id,status,updated_at DESC)"
  ,"CREATE TABLE IF NOT EXISTS client_priority_weights (client_id TEXT PRIMARY KEY,weights_json TEXT NOT NULL,high_confidence_threshold REAL NOT NULL DEFAULT 0.90,medium_confidence_threshold REAL NOT NULL DEFAULT 0.70,updated_at TEXT NOT NULL)"
  ,"CREATE TABLE IF NOT EXISTS serp_snapshots (id TEXT PRIMARY KEY,client_id TEXT NOT NULL,keyword_id TEXT NOT NULL,job_id TEXT NOT NULL,provider TEXT NOT NULL,location TEXT NOT NULL DEFAULT '',language TEXT NOT NULL DEFAULT '',device TEXT NOT NULL DEFAULT 'desktop',checked_at TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'QUEUED',raw_data TEXT NOT NULL DEFAULT '{}',error TEXT,created_at TEXT NOT NULL)"
  ,"CREATE INDEX IF NOT EXISTS idx_serp_snapshots_client_keyword ON serp_snapshots(client_id,keyword_id,checked_at DESC)"
  ,"CREATE UNIQUE INDEX IF NOT EXISTS idx_serp_snapshot_job ON serp_snapshots(job_id)"
  ,"CREATE TABLE IF NOT EXISTS serp_results (id TEXT PRIMARY KEY,client_id TEXT NOT NULL,snapshot_id TEXT NOT NULL,rank INTEGER NOT NULL,result_type TEXT NOT NULL DEFAULT 'organic',url TEXT NOT NULL,domain TEXT NOT NULL DEFAULT '',title TEXT NOT NULL DEFAULT '',description TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL)"
  ,"CREATE UNIQUE INDEX IF NOT EXISTS idx_serp_result_snapshot_rank_url ON serp_results(snapshot_id,rank,url)"
  ,"CREATE TABLE IF NOT EXISTS serp_usage_events (id TEXT PRIMARY KEY,client_id TEXT NOT NULL,provider TEXT NOT NULL,keyword_id TEXT NOT NULL,request_count INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL)"
  ,"CREATE TABLE IF NOT EXISTS article_versions (id TEXT PRIMARY KEY,client_id TEXT NOT NULL,article_id TEXT NOT NULL,version_no INTEGER NOT NULL,draft_json TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'GENERATING',created_at TEXT NOT NULL,updated_at TEXT NOT NULL)"
  ,"CREATE UNIQUE INDEX IF NOT EXISTS idx_article_version_unique ON article_versions(client_id,article_id,version_no)"
  ,"CREATE TABLE IF NOT EXISTS content_claims (id TEXT PRIMARY KEY,client_id TEXT NOT NULL,article_version_id TEXT NOT NULL,article_id TEXT NOT NULL,paragraph_index INTEGER NOT NULL,sentence TEXT NOT NULL,claim_text TEXT NOT NULL,claim_type TEXT NOT NULL,risk_level TEXT NOT NULL,requires_verification INTEGER NOT NULL,verification_status TEXT NOT NULL,verification_reason TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,updated_at TEXT NOT NULL)"
  ,"CREATE UNIQUE INDEX IF NOT EXISTS idx_claim_version_paragraph_text ON content_claims(article_version_id,paragraph_index,claim_text)"
  ,"CREATE TABLE IF NOT EXISTS claim_sources (id TEXT PRIMARY KEY,client_id TEXT NOT NULL,claim_id TEXT NOT NULL,source_type TEXT NOT NULL,source_url TEXT NOT NULL DEFAULT '',source_title TEXT NOT NULL DEFAULT '',publisher TEXT NOT NULL DEFAULT '',published_at TEXT,accessed_at TEXT NOT NULL,evidence_excerpt TEXT NOT NULL DEFAULT '',evidence_strength TEXT NOT NULL,supports_claim INTEGER NOT NULL DEFAULT 0,contradiction_detected INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL)"
  ,"CREATE UNIQUE INDEX IF NOT EXISTS idx_claim_source_unique ON claim_sources(claim_id,source_type,source_url,evidence_excerpt)"
  ,"CREATE TABLE IF NOT EXISTS article_eeat_assessments (id TEXT PRIMARY KEY,client_id TEXT NOT NULL,article_version_id TEXT NOT NULL,experience_score REAL NOT NULL,expertise_score REAL NOT NULL,authoritativeness_score REAL NOT NULL,trust_score REAL NOT NULL,missing_evidence_json TEXT NOT NULL DEFAULT '[]',created_at TEXT NOT NULL)"
  ,"CREATE UNIQUE INDEX IF NOT EXISTS idx_eeat_version ON article_eeat_assessments(article_version_id)"
  ,"CREATE TABLE IF NOT EXISTS article_ymyl_assessments (id TEXT PRIMARY KEY,client_id TEXT NOT NULL,article_version_id TEXT NOT NULL,risk TEXT NOT NULL,reason TEXT NOT NULL,required_reviews_json TEXT NOT NULL DEFAULT '[]',created_at TEXT NOT NULL)"
  ,"CREATE UNIQUE INDEX IF NOT EXISTS idx_ymyl_version ON article_ymyl_assessments(article_version_id)"
  ,"CREATE TABLE IF NOT EXISTS human_review_queue (id TEXT PRIMARY KEY,client_id TEXT NOT NULL,article_version_id TEXT NOT NULL,status TEXT NOT NULL,reason_codes_json TEXT NOT NULL DEFAULT '[]',notes TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,updated_at TEXT NOT NULL)"
  ,"CREATE UNIQUE INDEX IF NOT EXISTS idx_human_review_version ON human_review_queue(article_version_id)"
  ,"CREATE TABLE IF NOT EXISTS internal_link_candidates (id TEXT PRIMARY KEY,client_id TEXT NOT NULL,article_version_id TEXT NOT NULL,source_article_id TEXT NOT NULL,target_article_id TEXT NOT NULL,source_url TEXT NOT NULL DEFAULT '',target_url TEXT NOT NULL,anchor_text TEXT NOT NULL,anchor_type TEXT NOT NULL,relation_type TEXT NOT NULL,relevance_score REAL NOT NULL,intent_match INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL,validation_reason TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,updated_at TEXT NOT NULL)"
  ,"CREATE UNIQUE INDEX IF NOT EXISTS idx_link_candidate_unique ON internal_link_candidates(article_version_id,target_article_id,anchor_text)"
  ,"CREATE TABLE IF NOT EXISTS article_quality_reviews (id TEXT PRIMARY KEY,client_id TEXT NOT NULL,article_version_id TEXT NOT NULL,total_score REAL NOT NULL,breakdown_json TEXT NOT NULL,auto_publish_status TEXT NOT NULL,reasons_json TEXT NOT NULL DEFAULT '[]',manual_publish_allowed INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL)"
  ,"CREATE UNIQUE INDEX IF NOT EXISTS idx_quality_version ON article_quality_reviews(article_version_id)"
  ,"CREATE TABLE IF NOT EXISTS human_review_events (id TEXT PRIMARY KEY,client_id TEXT NOT NULL,article_version_id TEXT NOT NULL,review_id TEXT NOT NULL,reviewed_by TEXT NOT NULL,review_status TEXT NOT NULL,review_note TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL)"
  ,"CREATE INDEX IF NOT EXISTS idx_review_events_version ON human_review_events(client_id,article_version_id,created_at)"
  ,"CREATE TABLE IF NOT EXISTS article_status_history (id TEXT PRIMARY KEY,client_id TEXT NOT NULL,article_id TEXT NOT NULL,article_version_id TEXT NOT NULL,from_status TEXT,to_status TEXT NOT NULL,reason TEXT NOT NULL DEFAULT '',changed_by TEXT NOT NULL DEFAULT 'system',transition_event TEXT NOT NULL,changed_at TEXT NOT NULL)"
  ,"CREATE UNIQUE INDEX IF NOT EXISTS idx_article_status_transition_once ON article_status_history(article_version_id,from_status,to_status,transition_event)"
  ,"CREATE INDEX IF NOT EXISTS idx_article_status_history_version ON article_status_history(client_id,article_version_id,changed_at)"
  ,"CREATE TABLE IF NOT EXISTS client_publish_settings (client_id TEXT PRIMARY KEY,auto_publish_enabled INTEGER NOT NULL DEFAULT 0,auto_create_category INTEGER NOT NULL DEFAULT 0,tag_limit INTEGER NOT NULL DEFAULT 5,updated_at TEXT NOT NULL)"
  ,"CREATE TABLE IF NOT EXISTS wordpress_article_mappings (id TEXT PRIMARY KEY,client_id TEXT NOT NULL,article_id TEXT NOT NULL,article_version_id TEXT NOT NULL,wordpress_connection_id TEXT,wordpress_post_id TEXT NOT NULL,wordpress_url TEXT NOT NULL DEFAULT '',wordpress_status TEXT NOT NULL DEFAULT '',seo_plugin TEXT NOT NULL DEFAULT 'UNKNOWN',created_at TEXT NOT NULL,updated_at TEXT NOT NULL)"
  ,"CREATE UNIQUE INDEX IF NOT EXISTS idx_wp_mapping_version_intent ON wordpress_article_mappings(client_id,article_version_id,wordpress_post_id)"
  ,"CREATE TABLE IF NOT EXISTS wordpress_article_versions (id TEXT PRIMARY KEY,client_id TEXT NOT NULL,article_id TEXT NOT NULL,article_version_id TEXT NOT NULL,wordpress_post_id TEXT NOT NULL,wp_title TEXT NOT NULL DEFAULT '',wp_slug TEXT NOT NULL DEFAULT '',wp_content TEXT NOT NULL DEFAULT '',wp_excerpt TEXT NOT NULL DEFAULT '',wp_status TEXT NOT NULL DEFAULT '',categories_json TEXT NOT NULL DEFAULT '[]',tags_json TEXT NOT NULL DEFAULT '[]',featured_media_id TEXT,seo_meta_json TEXT NOT NULL DEFAULT '{}',captured_at TEXT NOT NULL)"
  ,"CREATE INDEX IF NOT EXISTS idx_wp_versions_article ON wordpress_article_versions(client_id,article_id,captured_at DESC)"
  ,"CREATE TABLE IF NOT EXISTS wordpress_publish_history (id TEXT PRIMARY KEY,client_id TEXT NOT NULL,article_id TEXT NOT NULL,article_version_id TEXT NOT NULL,job_id TEXT NOT NULL,operation TEXT NOT NULL,publish_type TEXT NOT NULL,wordpress_post_id TEXT,wordpress_url TEXT NOT NULL DEFAULT '',wordpress_status TEXT NOT NULL DEFAULT '',request_id TEXT NOT NULL,response_status INTEGER,result_json TEXT NOT NULL DEFAULT '{}',error_code TEXT,created_at TEXT NOT NULL)"
  ,"CREATE UNIQUE INDEX IF NOT EXISTS idx_wp_publish_idempotency ON wordpress_publish_history(client_id,article_version_id,operation,request_id)"
  ,"CREATE TABLE IF NOT EXISTS redirect_recommendations (id TEXT PRIMARY KEY,client_id TEXT NOT NULL,article_id TEXT,source_url TEXT NOT NULL,target_url TEXT NOT NULL,reason TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'PENDING',created_at TEXT NOT NULL,updated_at TEXT NOT NULL)"
  ,"CREATE TABLE IF NOT EXISTS article_seo_data (id TEXT PRIMARY KEY,client_id TEXT NOT NULL,article_id TEXT NOT NULL,article_version_id TEXT NOT NULL,seo_title TEXT NOT NULL DEFAULT '',meta_description TEXT NOT NULL DEFAULT '',focus_keyword TEXT NOT NULL DEFAULT '',canonical_url TEXT NOT NULL DEFAULT '',robots TEXT NOT NULL DEFAULT 'index,follow',schema_recommendation_json TEXT NOT NULL DEFAULT '{}',provider TEXT NOT NULL DEFAULT 'NATIVE_SEO_LOOP',plugin_sync_status TEXT NOT NULL DEFAULT 'NOT_APPLICABLE',canonical_status TEXT NOT NULL DEFAULT 'CANONICAL_STORED_IN_SEO_LOOP',schema_status TEXT NOT NULL DEFAULT 'SCHEMA_OUTPUT_NOT_AVAILABLE',created_at TEXT NOT NULL,updated_at TEXT NOT NULL)"
  ,"CREATE UNIQUE INDEX IF NOT EXISTS idx_article_seo_data_version ON article_seo_data(client_id,article_version_id)"
  ,"CREATE TABLE IF NOT EXISTS client_autopilot_settings (client_id TEXT PRIMARY KEY,mode TEXT NOT NULL DEFAULT 'OFF',new_article_priority_mode INTEGER NOT NULL DEFAULT 0,paused INTEGER NOT NULL DEFAULT 0,weekly_action_limit INTEGER NOT NULL DEFAULT 1,serp_refresh_limit INTEGER NOT NULL DEFAULT 4,article_generation_limit INTEGER NOT NULL DEFAULT 1,last_run_at TEXT,updated_at TEXT NOT NULL)"
  ,"CREATE TABLE IF NOT EXISTS global_autopilot_settings (id TEXT PRIMARY KEY,kill_switch_enabled INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL)"
  ,"CREATE TABLE IF NOT EXISTS autopilot_runs (id TEXT PRIMARY KEY,client_id TEXT NOT NULL,week_key TEXT NOT NULL,run_key TEXT NOT NULL,trigger_type TEXT NOT NULL,freshness_json TEXT NOT NULL DEFAULT '{}',input_snapshot_json TEXT NOT NULL DEFAULT '{}',result_json TEXT NOT NULL DEFAULT '{}',status TEXT NOT NULL DEFAULT 'COMPLETED',created_at TEXT NOT NULL)"
  ,"CREATE UNIQUE INDEX IF NOT EXISTS idx_autopilot_run_once ON autopilot_runs(client_id,week_key,run_key)"
  ,"CREATE INDEX IF NOT EXISTS idx_autopilot_runs_client ON autopilot_runs(client_id,created_at DESC)"
  ,"CREATE TABLE IF NOT EXISTS autopilot_actions (id TEXT PRIMARY KEY,client_id TEXT NOT NULL,run_id TEXT NOT NULL,week_key TEXT NOT NULL,action_type TEXT NOT NULL,target_keyword_id TEXT,target_article_id TEXT,target_topic_id TEXT,target_cluster_id TEXT,reason_json TEXT NOT NULL DEFAULT '{}',evidence_json TEXT NOT NULL DEFAULT '{}',expected_impact TEXT NOT NULL,confidence TEXT NOT NULL,risk TEXT NOT NULL,score REAL NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'RECOMMENDED',before_metrics_json TEXT NOT NULL DEFAULT '{}',after_metrics_json TEXT NOT NULL DEFAULT '{}',execution_result_json TEXT NOT NULL DEFAULT '{}',created_at TEXT NOT NULL,updated_at TEXT NOT NULL)"
  ,"CREATE UNIQUE INDEX IF NOT EXISTS idx_autopilot_primary_action ON autopilot_actions(client_id,week_key)"
  ,"CREATE INDEX IF NOT EXISTS idx_autopilot_actions_client ON autopilot_actions(client_id,created_at DESC)"
  ,"CREATE TABLE IF NOT EXISTS autopilot_measurements (id TEXT PRIMARY KEY,client_id TEXT NOT NULL,action_id TEXT NOT NULL,window_days INTEGER NOT NULL,metrics_json TEXT NOT NULL DEFAULT '{}',result_status TEXT NOT NULL DEFAULT 'INSUFFICIENT_DATA',measured_at TEXT NOT NULL)"
  ,"CREATE UNIQUE INDEX IF NOT EXISTS idx_autopilot_measurement_window ON autopilot_measurements(action_id,window_days)"
  ,"CREATE TABLE IF NOT EXISTS autopilot_audit_log (id TEXT PRIMARY KEY,client_id TEXT NOT NULL,run_id TEXT,action_id TEXT,event_type TEXT NOT NULL,detail_json TEXT NOT NULL DEFAULT '{}',created_at TEXT NOT NULL)"
  ,"CREATE INDEX IF NOT EXISTS idx_autopilot_audit_client ON autopilot_audit_log(client_id,created_at DESC)"
];
let initialized = false;
export async function ensureSchema() {
  if (initialized) return;
  const db = runtime().DB;
  await db.batch(schema.map(sql => db.prepare(sql)));
  initialized = true;
}

function bytesToBase64(bytes: Uint8Array) { let value = ""; for (const byte of bytes) value += String.fromCharCode(byte); return btoa(value); }
function base64ToBytes(value: string) { const raw = atob(value); return Uint8Array.from(raw, char => char.charCodeAt(0)); }
async function encryptionKey() {
  const secret = runtime().CREDENTIALS_ENCRYPTION_KEY;
  if (!secret) throw new Error("サーバーの暗号化キーが未設定です。");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}
export async function encrypt(value: unknown) { const iv = crypto.getRandomValues(new Uint8Array(12)); const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await encryptionKey(), new TextEncoder().encode(JSON.stringify(value))); return `${bytesToBase64(iv)}.${bytesToBase64(new Uint8Array(cipher))}`; }
export async function decrypt<T>(value: string): Promise<T> { const [iv, cipher] = value.split("."); const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: base64ToBytes(iv) }, await encryptionKey(), base64ToBytes(cipher)); return JSON.parse(new TextDecoder().decode(plain)); }
export async function sha256(value: string) { return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))).map(byte => byte.toString(16).padStart(2, "0")).join(""); }

export async function ownedClient(clientId: string, owner: string) {
  return runtime().DB.prepare("SELECT * FROM clients WHERE id = ? AND owner_id = ?").bind(clientId, owner).first<Record<string, unknown>>();
}
export async function log(clientId: string, message: string, level = "info", detail: unknown = {}) {
  await runtime().DB.prepare("INSERT INTO logs (id,client_id,level,message,detail,created_at) VALUES (?,?,?,?,?,?)").bind(id(), clientId, level, message.slice(0, 500), JSON.stringify(detail), now()).run();
}
