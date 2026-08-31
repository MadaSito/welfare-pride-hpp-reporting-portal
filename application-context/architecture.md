# Application Context: Architecture and Decisions

## Purpose

The portal operationalizes HPP outreach reporting while preserving tenant separation between customer organizations. Administrators prepare validated datasets and publish versioned reports. Customers can access only their tenant’s published reports and authorized reporting periods.

## Runtime Topology

The self-hosted application is a React interface served by a Node/Express process. PostgreSQL holds relational reporting metadata, user lifecycle state, and append-only audit events. Redis is provisioned for distributed rate-limit buckets, session revocation, and work coordination as the deployment scales. A reverse proxy provides TLS termination, request-size enforcement, and public routing. Source files are stored in a mounted volume in the initial self-hosted configuration; transition this to encrypted object storage with malware scanning for production healthcare workloads.

## Data Model Vocabulary

| Concept | Responsibility |
|---|---|
| Tenant | Customer organization boundary. |
| User | Authenticated individual with a local or future federated identity. |
| Dataset template | Controlled header, type, and outcome-code mapping. |
| Upload | Immutable source-provenance and validation record for one source period. |
| Outreach record | Normalized call/outreach row linked to a governed upload. |
| Report | Versioned dashboard layout and metric configuration. |
| Report publication | Tenant-specific authorization for a report and reporting periods. |
| Audit event | Append-only security and business-action record. |

## HPP Code Mapping

Call attempt comments use numeric outcomes including `11` for voicemail, `12` for helping complete renewal, `16` for client hung up, `8` and `9` for invalid numbers, `51` for negative response, and `100` for no further calls or visits. Final call statuses include `NFCN1`, `NFCN2`, and `NFCN3` for no further contact needed after the respective rounds. The ingestion layer must store the original code, a normalized code, and an approved display label so reports remain traceable to source content.

## Design Language

The visual system is named **Trusted Civic Clarity**. It uses the supplied Welfare Pride logomark, Roboto typography, `#5A92C9` blue as the information and trust color, `#D58240` orange for progress and human attention, deep ink navigation, and spacious white operational surfaces. The copy voice is plainspoken, civic, and reassuring. Focus indication, color contrast, responsive stacking, keyboard navigation, and reduced motion are mandatory design constraints.
