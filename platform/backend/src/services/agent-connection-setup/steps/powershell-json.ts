/** Serialize JSON values without PowerShell's extended object metadata. */
export function renderPowerShellJsonWriter(name: string): string {
  // white-label-ok: Stable internal CLR type shared by setup and cleanup, not display text.
  return `function ${name}($Value) {
  if (-not ('Archestra.ConnectionSetup.JsonValuesV1' -as [type])) {
    Add-Type -TypeDefinition '
using System;
using System.Collections;
using System.Collections.Generic;
using System.Management.Automation;

namespace Archestra.ConnectionSetup {
  public static class JsonValuesV1 {
    public static object Unwrap(object value) { return Unwrap(value, 0); }

    private static object Unwrap(object value, int depth) {
      if (depth > 100) throw new ArgumentException("JSON nesting exceeds the supported limit");
      while (value is PSObject) {
        object next = ((PSObject)value).BaseObject;
        if (Object.ReferenceEquals(value, next)) throw new ArgumentException("Invalid PowerShell JSON wrapper");
        value = next;
      }
      if (value == null) return null;
      IDictionary map = value as IDictionary;
      if (map != null) {
        var plain = new Dictionary<string, object>(StringComparer.Ordinal);
        foreach (DictionaryEntry entry in map) {
          if (!(entry.Key is string)) throw new ArgumentException("JSON object keys must be strings");
          plain.Add((string)entry.Key, Unwrap(entry.Value, depth + 1));
        }
        return plain;
      }
      IList list = value as IList;
      if (list != null) {
        var plain = new object[list.Count];
        for (int i = 0; i < list.Count; i++) plain[i] = Unwrap(list[i], depth + 1);
        return plain;
      }
      return value;
    }
  }
}
' -ErrorAction Stop
  }
  return (ConvertTo-Json -InputObject ([Archestra.ConnectionSetup.JsonValuesV1]::Unwrap($Value)) -Depth 100)
}`;
}
