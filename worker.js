/*
 * Cloudflare Worker
 *
 * Daily D1 -> R2 backup
 *
 * Required Worker configuration:
 *
 * Variables:
 *   ACCOUNT_ID
 *   DATABASE_ID
 *
 * Secret:
 *   D1_REST_API_TOKEN
 *
 * R2 binding:
 *   BACKUP_BUCKET -> backups
 *
 * Cron Trigger:
 *   configured in the Cloudflare dashboard
 */

const POLL_INTERVAL_MS = 5_000;

// Give the entire export process a hard upper bound.
// Individual HTTP requests have their own 30-second timeout below.
const MAX_EXPORT_TIME_MS = 10 * 60 * 1000;

const FETCH_TIMEOUT_MS = 30_000;


export default {
  async scheduled(controller, env, ctx) {
    await runBackup(env);
  },

  async fetch() {
    return new Response("D1 backup worker");
  },
};


/*
 * ------------------------------------------------------------
 * Main backup process
 * ------------------------------------------------------------
 */
async function runBackup(env) {

  validateEnvironment(env);

  const exportUrl =
    `https://api.cloudflare.com/client/v4/` +
    `accounts/${env.ACCOUNT_ID}/d1/database/` +
    `${env.DATABASE_ID}/export`;

  const headers = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${env.D1_REST_API_TOKEN}`,
  };


  /*
   * ----------------------------------------------------------
   * 1. Start the D1 export
   * ----------------------------------------------------------
   */

  console.log("Starting D1 export...");

  const startResponse = await fetchWithTimeout(
    exportUrl,
    {
      method: "POST",

      headers,

      body: JSON.stringify({
        output_format: "polling",
      }),
    },
    FETCH_TIMEOUT_MS,
  );


  const startBody =
    await readJson(startResponse);


  if (!startResponse.ok || !startBody.success) {
    throw new Error(
      "Failed to start D1 export: " +
      JSON.stringify(startBody),
    );
  }


  /*
   * Check for an actual D1 export error BEFORE
   * checking for the bookmark.
   *
   * This prevents a real API error from being
   * hidden behind "missing bookmark".
   */

  if (startBody.result?.status === "error") {
    throw new Error(
      "D1 export failed: " +
      (
        startBody.result.error ??
        "unknown error"
      ),
    );
  }


  const bookmark =
    startBody.result?.at_bookmark;


  if (!bookmark) {
    throw new Error(
      "D1 export did not return at_bookmark",
    );
  }


  console.log(
    `D1 export started. Bookmark: ${bookmark}`,
  );


  /*
   * ----------------------------------------------------------
   * 2. Poll until the export completes
   * ----------------------------------------------------------
   *
   * D1 requires an in-progress export to be continually
   * polled or the export will be cancelled.
   *
   * The export should be very small for this app,
   * but we still enforce a 10-minute upper bound.
   */

  const exportStartedAt = Date.now();

  let completedExport = null;


  while (!completedExport) {

    const elapsed =
      Date.now() - exportStartedAt;


    if (elapsed >= MAX_EXPORT_TIME_MS) {

      throw new Error(
        "D1 export exceeded the 10-minute timeout",
      );

    }


    /*
     * Wait before polling again.
     *
     * This is a normal Worker sleep, not a
     * Cloudflare Workflow sleep.
     */

    await sleep(POLL_INTERVAL_MS);


    console.log("Polling D1 export...");


    const pollResponse =
      await fetchWithTimeout(
        exportUrl,
        {
          method: "POST",

          headers,

          body: JSON.stringify({
            output_format: "polling",
            current_bookmark: bookmark,
          }),
        },
        FETCH_TIMEOUT_MS,
      );


    const pollBody =
      await readJson(pollResponse);


    if (
      !pollResponse.ok ||
      !pollBody.success
    ) {
      throw new Error(
        "D1 export polling failed: " +
        JSON.stringify(pollBody),
      );
    }


    const result =
      pollBody.result;


    if (!result) {
      throw new Error(
        "D1 export polling returned no result",
      );
    }


    /*
     * Explicitly handle the D1 error state.
     */

    if (result.status === "error") {

      throw new Error(
        "D1 export failed: " +
        (
          result.error ??
          "unknown error"
        ),
      );

    }


    /*
     * According to the current D1 API response,
     * filename and signed_url are nested here:
     *
     * result.result.filename
     * result.result.signed_url
     */

    const signedUrl =
      result.result?.signed_url;

    const filename =
      result.result?.filename;


    if (signedUrl) {

      completedExport = {
        signedUrl,
        filename,
      };

      console.log(
        "D1 export completed.",
      );

      break;

    }


    /*
     * No signed URL yet means the export is
     * still in progress.
     */

    console.log(
      "D1 export still running...",
    );

  }


  /*
   * ----------------------------------------------------------
   * 3. Download the completed SQL export
   * ----------------------------------------------------------
   */

  console.log(
    "Downloading completed D1 export...",
  );


  const dumpResponse =
    await fetchWithTimeout(
      completedExport.signedUrl,
      {
        method: "GET",
      },
      FETCH_TIMEOUT_MS,
    );


  if (!dumpResponse.ok) {

    throw new Error(
      "Failed to download D1 export: " +
      `${dumpResponse.status} ` +
      `${dumpResponse.statusText}`,
    );

  }


  if (!dumpResponse.body) {

    throw new Error(
      "D1 export response contained no body",
    );

  }


  /*
   * ----------------------------------------------------------
   * 4. Build the R2 object key
   * ----------------------------------------------------------
   */

  const now =
    new Date();


  const year =
    now.getUTCFullYear();


  const month =
    String(
      now.getUTCMonth() + 1,
    ).padStart(2, "0");


  const day =
    String(
      now.getUTCDate(),
    ).padStart(2, "0");


  const timestamp =
    now
      .toISOString()
      .replace(/:/g, "-")
      .replace(/\.\d{3}Z$/, "Z");


  const key =
    `production/` +
    `${year}/` +
    `${month}/` +
    `${day}/` +
    `${timestamp}_${bookmark}.sql`;


  /*
   * ----------------------------------------------------------
   * 5. Stream the SQL export directly into R2
   * ----------------------------------------------------------
   */

  console.log(
    `Writing backup to R2: ${key}`,
  );


  await env.BACKUP_BUCKET.put(
    key,
    dumpResponse.body,
    {
      httpMetadata: {
        contentType: "application/sql",
      },

      customMetadata: {
        databaseId:
          env.DATABASE_ID,

        d1Bookmark:
          bookmark,

        exportedAt:
          now.toISOString(),

        originalFilename:
          completedExport.filename ?? "",
      },
    },
  );


  console.log(
    `Backup completed successfully: ${key}`,
  );
}


/*
 * ------------------------------------------------------------
 * fetchWithTimeout()
 *
 * Gives every network request its own timeout.
 * ------------------------------------------------------------
 */
async function fetchWithTimeout(
  input,
  init = {},
  timeoutMs = FETCH_TIMEOUT_MS,
) {

  try {

    return await fetch(
      input,
      {
        ...init,

        signal:
          AbortSignal.timeout(timeoutMs),
      },
    );

  } catch (error) {

    if (
      error &&
      error.name === "TimeoutError"
    ) {

      throw new Error(
        `HTTP request timed out after ` +
        `${timeoutMs / 1000} seconds: ` +
        `${String(input)}`,
      );

    }

    throw error;
  }
}


/*
 * ------------------------------------------------------------
 * Safely parse a JSON response.
 * ------------------------------------------------------------
 */
async function readJson(response) {

  const text =
    await response.text();


  try {

    return text
      ? JSON.parse(text)
      : {};

  } catch (error) {

    throw new Error(
      "Cloudflare API returned invalid JSON: " +
      text.slice(0, 1000),
    );

  }
}


/*
 * ------------------------------------------------------------
 * Validate Worker configuration up front.
 * ------------------------------------------------------------
 */
function validateEnvironment(env) {

  const required = [
    "ACCOUNT_ID",
    "DATABASE_ID",
    "D1_REST_API_TOKEN",
    "BACKUP_BUCKET",
  ];


  for (const name of required) {

    if (!env[name]) {

      throw new Error(
        `Missing required Worker configuration: ${name}`,
      );

    }

  }
}


/*
 * ------------------------------------------------------------
 * Simple async delay for polling.
 * ------------------------------------------------------------
 */
function sleep(ms) {

  return new Promise(
    (resolve) => {
      setTimeout(resolve, ms);
    },
  );
}
