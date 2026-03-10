/**
 * SearchScore GEO Audit API
 * Cloudflare Pages Function
 *
 * GET /api/audit?url=https://example.com
 * Header: X-API-Key: <key>
 *
 * Returns JSON with overall score + 6 category scores + signals
 */

const API_KEY = "ss_live_7x9mKpQnRvWtXzY2aB4cD8eF3gH";

// Weights match the landing page categories
const WEIGHTS = {
  ai_citability:    0.25,
  brand_authority:  0.20,
  content_quality:  0.20,
  technical:        0.15,
  structured_data:  0.10,
  platform_opti:    0.10,
};

export async function onRequest(context) {
  const { request } = context;

  // CORS headers
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "X-API-Key, Content-Type",
    "Content-Type": "application/json",
  };

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  // Auth check
  const apiKey = request.headers.get("X-API-Key") || new URL(request.url).searchParams.get("api_key");
  if (apiKey !== API_KEY) {
    return new Response(JSON.stringify({ error: "Unauthorised", message: "Valid X-API-Key required" }), {
      status: 401, headers: corsHeaders,
    });
  }

  // URL param
  const { searchParams } = new URL(request.url);
  const targetUrl = searchParams.get("url");
  if (!targetUrl) {
    return new Response(JSON.stringify({ error: "Missing param", message: "url query param required" }), {
      status: 400, headers: corsHeaders,
    });
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(targetUrl.startsWith("http") ? targetUrl : "https://" + targetUrl);
  } catch {
    return new Response(JSON.stringify({ error: "Invalid URL", message: "Could not parse the provided URL" }), {
      status: 400, headers: corsHeaders,
    });
  }

  try {
    const result = await runAudit(parsedUrl);
    return new Response(JSON.stringify(result, null, 2), { status: 200, headers: corsHeaders });
  } catch (err) {
    return new Response(JSON.stringify({ error: "Audit failed", message: err.message }), {
      status: 500, headers: corsHeaders,
    });
  }
}

async function runAudit(url) {
  const base = url.origin;
  const domain = url.hostname;

  // Fetch the homepage HTML
  let html = "";
  let httpStatus = 0;
  let finalUrl = base;
  let isHttps = url.protocol === "https:";

  try {
    const resp = await fetch(base, {
      headers: { "User-Agent": "SearchScoreBot/1.0 (+https://searchscore.io)" },
      redirect: "follow",
      cf: { timeout: 10000 },
    });
    httpStatus = resp.status;
    finalUrl = resp.url;
    isHttps = finalUrl.startsWith("https://");
    html = await resp.text();
  } catch {
    html = "";
  }

  // Parallel fetches for auxiliary files
  const [robotsTxt, sitemapXml, llmsTxt] = await Promise.all([
    fetchText(`${base}/robots.txt`),
    fetchText(`${base}/sitemap.xml`),
    fetchText(`${base}/llms.txt`),
  ]);

  // ── 1. AI CITABILITY (25%) ───────────────────────────────────
  const signals_ai = {};
  signals_ai.llms_txt_present = llmsTxt !== null;
  signals_ai.gptbot_allowed   = robotsAllows(robotsTxt, "GPTBot");
  signals_ai.claudebot_allowed = robotsAllows(robotsTxt, "ClaudeBot");
  signals_ai.perplexitybot_allowed = robotsAllows(robotsTxt, "PerplexityBot");
  signals_ai.bingbot_allowed  = robotsAllows(robotsTxt, "Bingbot");
  signals_ai.robots_txt_present = robotsTxt !== null;

  let ai_score = 0;
  if (signals_ai.llms_txt_present)         ai_score += 35;
  if (signals_ai.gptbot_allowed)           ai_score += 15;
  if (signals_ai.claudebot_allowed)        ai_score += 15;
  if (signals_ai.perplexitybot_allowed)    ai_score += 15;
  if (signals_ai.robots_txt_present)       ai_score += 10;
  if (signals_ai.bingbot_allowed)          ai_score += 10;

  // ── 2. BRAND AUTHORITY (20%) ─────────────────────────────────
  const signals_brand = {};
  signals_brand.has_linkedin_link   = /linkedin\.com/.test(html);
  signals_brand.has_twitter_link    = /twitter\.com|x\.com/.test(html);
  signals_brand.has_contact_page    = /contact|about/i.test(html);
  signals_brand.has_address         = /[A-Z]{1,2}[0-9][0-9A-Z]?\s[0-9][A-Z]{2}|street|avenue|road/i.test(html);
  signals_brand.has_phone           = /(\+44|0[0-9]{4}[\s-]?[0-9]{3,4}[\s-]?[0-9]{3,4}|\(\d{3}\)\s?\d{3}-\d{4})/.test(html);
  signals_brand.has_about_page      = /href=["'][^"']*about/i.test(html);

  let brand_score = 0;
  if (signals_brand.has_linkedin_link)  brand_score += 20;
  if (signals_brand.has_twitter_link)   brand_score += 15;
  if (signals_brand.has_contact_page)   brand_score += 20;
  if (signals_brand.has_address)        brand_score += 20;
  if (signals_brand.has_phone)          brand_score += 15;
  if (signals_brand.has_about_page)     brand_score += 10;

  // ── 3. CONTENT QUALITY / E-E-A-T (20%) ──────────────────────
  const signals_content = {};
  signals_content.has_author_bio     = /author|by\s+[A-Z][a-z]+\s+[A-Z]/i.test(html);
  signals_content.has_date           = /202[0-9]|published|updated/i.test(html);
  signals_content.has_blog_or_articles = /blog|article|insight|resource/i.test(html);
  signals_content.word_count_ok      = html.replace(/<[^>]+>/g, " ").split(/\s+/).length > 400;
  signals_content.has_sources_links  = html.match(/href="https?:\/\//g)?.length > 3;
  signals_content.has_credentials    = /PhD|MBA|MRICS|FCCA|chartered|certified|qualified|expert/i.test(html);

  let content_score = 0;
  if (signals_content.has_author_bio)        content_score += 25;
  if (signals_content.has_date)              content_score += 15;
  if (signals_content.has_blog_or_articles)  content_score += 20;
  if (signals_content.word_count_ok)         content_score += 20;
  if (signals_content.has_sources_links)     content_score += 10;
  if (signals_content.has_credentials)       content_score += 10;

  // ── 4. TECHNICAL FOUNDATIONS (15%) ───────────────────────────
  const signals_tech = {};
  signals_tech.https              = isHttps;
  signals_tech.sitemap_present    = sitemapXml !== null;
  signals_tech.canonical_present  = /<link[^>]+rel=["']canonical["']/i.test(html);
  signals_tech.viewport_meta      = /<meta[^>]+viewport/i.test(html);
  signals_tech.lang_attribute     = /<html[^>]+lang=/i.test(html);
  signals_tech.response_ok        = httpStatus >= 200 && httpStatus < 300;

  let tech_score = 0;
  if (signals_tech.https)              tech_score += 30;
  if (signals_tech.sitemap_present)    tech_score += 25;
  if (signals_tech.canonical_present)  tech_score += 20;
  if (signals_tech.viewport_meta)      tech_score += 15;
  if (signals_tech.lang_attribute)     tech_score += 5;
  if (signals_tech.response_ok)        tech_score += 5;

  // ── 5. STRUCTURED DATA (10%) ─────────────────────────────────
  const signals_schema = {};
  signals_schema.has_schema_org      = /schema\.org/i.test(html);
  signals_schema.has_json_ld         = /application\/ld\+json/i.test(html);
  signals_schema.has_organization    = /Organization|LocalBusiness/i.test(html);
  signals_schema.has_article_schema  = /"Article"|"BlogPosting"/i.test(html);
  signals_schema.has_faq_schema      = /FAQPage/i.test(html);
  signals_schema.has_person_schema   = /\"Person\"/i.test(html);

  let schema_score = 0;
  if (signals_schema.has_json_ld)         schema_score += 30;
  if (signals_schema.has_schema_org)      schema_score += 10;
  if (signals_schema.has_organization)    schema_score += 25;
  if (signals_schema.has_article_schema)  schema_score += 20;
  if (signals_schema.has_faq_schema)      schema_score += 10;
  if (signals_schema.has_person_schema)   schema_score += 5;

  // ── 6. PLATFORM OPTIMISATION (10%) ───────────────────────────
  const signals_platform = {};
  signals_platform.og_title       = /<meta[^>]+property=["']og:title["']/i.test(html);
  signals_platform.og_description = /<meta[^>]+property=["']og:description["']/i.test(html);
  signals_platform.og_image       = /<meta[^>]+property=["']og:image["']/i.test(html);
  signals_platform.twitter_card   = /<meta[^>]+name=["']twitter:card["']/i.test(html);
  signals_platform.twitter_title  = /<meta[^>]+name=["']twitter:title["']/i.test(html);
  signals_platform.meta_desc      = /<meta[^>]+name=["']description["']/i.test(html);

  let platform_score = 0;
  if (signals_platform.og_title)       platform_score += 20;
  if (signals_platform.og_description) platform_score += 20;
  if (signals_platform.og_image)       platform_score += 20;
  if (signals_platform.twitter_card)   platform_score += 15;
  if (signals_platform.twitter_title)  platform_score += 15;
  if (signals_platform.meta_desc)      platform_score += 10;

  // ── OVERALL SCORE ─────────────────────────────────────────────
  const weighted =
    ai_score     * WEIGHTS.ai_citability  +
    brand_score  * WEIGHTS.brand_authority +
    content_score * WEIGHTS.content_quality +
    tech_score   * WEIGHTS.technical +
    schema_score * WEIGHTS.structured_data +
    platform_score * WEIGHTS.platform_opti;

  const overall = Math.round(weighted);

  const tier =
    overall >= 86 ? "AI-Ready" :
    overall >= 71 ? "Strong" :
    overall >= 51 ? "Developing" :
    overall >= 31 ? "Weak" : "Invisible";

  // ── TOP FIXES ─────────────────────────────────────────────────
  const fixes = [];
  if (!signals_ai.llms_txt_present)      fixes.push({ priority: "high", category: "AI Citability", fix: "Add an /llms.txt file listing your site name, description and key pages" });
  if (!signals_ai.gptbot_allowed)        fixes.push({ priority: "high", category: "AI Citability", fix: "Allow GPTBot in robots.txt (or remove blocking rules)" });
  if (!signals_ai.claudebot_allowed)     fixes.push({ priority: "high", category: "AI Citability", fix: "Allow ClaudeBot in robots.txt" });
  if (!signals_ai.perplexitybot_allowed) fixes.push({ priority: "high", category: "AI Citability", fix: "Allow PerplexityBot in robots.txt" });
  if (!signals_schema.has_json_ld)       fixes.push({ priority: "high", category: "Structured Data", fix: "Add JSON-LD schema markup (start with Organization + WebSite types)" });
  if (!signals_schema.has_organization)  fixes.push({ priority: "high", category: "Structured Data", fix: "Add Organization or LocalBusiness schema with full NAP data" });
  if (!signals_tech.sitemap_present)     fixes.push({ priority: "medium", category: "Technical", fix: "Create and submit an XML sitemap at /sitemap.xml" });
  if (!signals_tech.canonical_present)   fixes.push({ priority: "medium", category: "Technical", fix: "Add canonical link tags to prevent duplicate content issues" });
  if (!signals_content.has_author_bio)   fixes.push({ priority: "medium", category: "Content / E-E-A-T", fix: "Add author bios with credentials to articles and blog posts" });
  if (!signals_brand.has_linkedin_link)  fixes.push({ priority: "low", category: "Brand Authority", fix: "Link to your LinkedIn profile or company page" });
  if (!signals_platform.og_image)        fixes.push({ priority: "low", category: "Platform", fix: "Add og:image meta tag with a 1200x630 image" });

  return {
    url: parsedUrl.href,
    domain,
    audited_at: new Date().toISOString(),
    overall_score: overall,
    tier,
    categories: {
      ai_citability:   { score: ai_score,      weight: "25%", signals: signals_ai },
      brand_authority: { score: brand_score,   weight: "20%", signals: signals_brand },
      content_quality: { score: content_score, weight: "20%", signals: signals_content },
      technical:       { score: tech_score,    weight: "15%", signals: signals_tech },
      structured_data: { score: schema_score,  weight: "10%", signals: signals_schema },
      platform_opti:   { score: platform_score,weight: "10%", signals: signals_platform },
    },
    top_fixes: fixes.slice(0, 8),
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function fetchText(url) {
  try {
    const resp = await fetch(url, {
      headers: { "User-Agent": "SearchScoreBot/1.0 (+https://searchscore.io)" },
      cf: { timeout: 5000 },
    });
    if (resp.ok) return await resp.text();
    return null;
  } catch {
    return null;
  }
}

/**
 * Returns true if the given bot is NOT blocked in robots.txt.
 * Treats missing robots.txt as "allowed".
 */
function robotsAllows(robotsTxt, botName) {
  if (!robotsTxt) return true; // no robots.txt = open
  const lines = robotsTxt.split("\n");
  let inScope = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (/^user-agent:/i.test(line)) {
      const agent = line.replace(/^user-agent:\s*/i, "").trim();
      inScope = agent === "*" || agent.toLowerCase() === botName.toLowerCase();
    }
    if (inScope && /^disallow:\s*\//i.test(line)) {
      return false; // blocked
    }
  }
  return true;
}
