# Evidence Statuses

| Status | Meaning |
| --- | --- |
| `found` | At least one exact result was returned for the normalized allele. |
| `no exact match` | The resource was queried successfully but no exact contig/POS/REF/ALT match existed. |
| `not computed` | No evaluation request has completed for this allele/resource identity. |
| `resource unavailable` | The configured executable, data file, or index could not be used. |
| `error` | The resource ran but returned a process, parsing, timeout, or query failure. |

These values are deliberately not ordered from good to bad. In particular, `no exact match` is not a benign assertion, and `found` does not mean pathogenic. The contents and provenance of the matched record must be interpreted in context.

