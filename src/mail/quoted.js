/**
 * The current human-authored part of an email thread.
 *
 * The full message remains immutable evidence in NEDB. This creates only the
 * analysis view sent to Muse, removing quoted copies of Yente's own prior mail so
 * her profile summaries cannot be re-extracted as new member claims.
 */
export function currentReplyOnly(source) {
  const text = String(source ?? "");
  const lines = text.split(/\r?\n/);
  let cut = lines.length;

  const markers = [
    // iOS / Apple Mail and common clients.
    /^>\s*On\s+.+\bYente\s*<yente@ccme\.network>\s+wrote:\s*$/i,
    /^On\s+.+\bYente\s*<yente@ccme\.network>\s+wrote:\s*$/i,
    // Traditional forwarded/original-message separators.
    /^[-_]{2,}\s*Original Message\s*[-_]{2,}$/i,
    /^Begin forwarded message:\s*$/i,
  ];

  for (let i = 0; i < lines.length; i += 1) {
    if (markers.some((pattern) => pattern.test(lines[i].trim()))) {
      cut = i;
      break;
    }
  }

  return lines.slice(0, cut).join("\n").trim();
}
