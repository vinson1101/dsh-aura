/**
 * Where the provider key comes from, host side.
 *
 * The key never enters the repository and never reaches the browser. It is
 * resolved per request, in this order:
 *
 * 1. the plugin row's `asr.apiKey` (a literal, for a throwaway profile)
 * 2. the DSH credential record `dsh-aura/asr`, when the credentials service is
 *    present — the sanctioned place for a secret
 * 3. the process environment
 * 4. `$DSH_HOME/aura-secrets.env`, the `.env` convention the Zebra bridge uses
 *
 * Reading per request means a rotated key applies to the next utterance with no
 * restart and no configuration edit.
 */

/** Parse the subset of dotenv that a hand-written secret file needs. */
export function parseEnvFile(text) {
  const values = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const at = line.indexOf('=');
    if (at <= 0) continue;
    const key = line.slice(0, at).trim();
    let value = line.slice(at + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) values[key] = value;
  }
  return values;
}

/**
 * @param {object} options
 * @param {() => Promise<string | undefined>} [options.readRecord] credential record reader
 * @param {Record<string, string | undefined>} [options.env] process environment
 * @param {string} [options.home] DSH home directory
 * @param {() => Promise<string>} [options.readSecretsFile] reads the dotenv file
 */
export function createKeyReader(options = {}) {
  const env = options.env || process.env;
  const readRecord = options.readRecord;
  const readSecretsFile = options.readSecretsFile;

  return async function readKey(configKey) {
    if (typeof configKey === 'string' && configKey.trim()) return configKey.trim();

    if (readRecord) {
      try {
        const record = await readRecord();
        const token = record && record.payload && record.payload.token;
        if (typeof token === 'string' && token.trim()) return token.trim();
      } catch {
        /* a missing record is not an error */
      }
    }

    const fromEnv = env.DASHSCOPE_API_KEY || env.XOB_BAILIAN_API_KEY || env.XOB_DASHSCOPE_API_KEY;
    if (typeof fromEnv === 'string' && fromEnv.trim()) return fromEnv.trim();

    if (readSecretsFile) {
      try {
        const values = parseEnvFile(await readSecretsFile());
        const fromFile = values.DASHSCOPE_API_KEY || values.XOB_BAILIAN_API_KEY;
        if (typeof fromFile === 'string' && fromFile.trim()) return fromFile.trim();
      } catch {
        /* no secret file is a normal state */
      }
    }

    return undefined;
  };
}
