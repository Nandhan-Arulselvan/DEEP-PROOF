# DeepProof

DeepProof is a PDF integrity system. It calculates SHA-256 from the exact submitted bytes, stores the PDF in Pinata/IPFS, records protected metadata and audit history in Supabase, and can confirm a wallet-signed `EvidenceRegistry` registration on Polygon.

It does **not** establish authorship or factual truth. A match establishes byte-level identity with the chosen trusted reference; a mismatch means the bytes differ.

## Architecture

| Component | Responsibility |
| --- | --- |
| Express static app | Supabase-authenticated dashboard and local development server |
| Supabase Postgres | Document metadata, audit events, verification history, RLS |
| Supabase Edge Functions | Server-side PDF validation, hashing, Pinata upload, persistence, verification, recovery, and chain confirmation |
| Pinata/IPFS | PDF bytes and a real CID — never a database BLOB or on-chain PDF |
| `EvidenceRegistry.sol` | Hash registration and immutable timestamp on EVM-compatible networks |

## Local web development

1. Copy `.env.example` to `.env.local` and provide the public Supabase URL/key. The supplied project has already been placed in the local `.env.local`; that file is ignored by Git.
2. Install dependencies with `npm install`.
3. Run `npm start`, then open [http://localhost:3000](http://localhost:3000).

The browser receives only the Supabase publishable key. Pinata JWTs, Supabase service-role keys, RPC credentials, and any wallet secrets must never be added to browser code or `.env.example`.

## Supabase deployment

Install and authenticate the Supabase CLI, then run the following from this directory. The commands reuse the existing project — they do not create one.

```bash
supabase login
supabase link --project-ref yebsxhfmheulctzatwvg
supabase db push
supabase secrets set PINATA_JWT="your-pinata-jwt"
supabase secrets set APP_ORIGIN="https://your-frontend-domain"
supabase functions deploy upload-document
supabase functions deploy verify-document
supabase functions deploy recover-document
supabase functions deploy document-library
supabase functions deploy confirm-blockchain-registration
```

The migration in `supabase/migrations/` creates `documents`, `verification_logs`, and `document_events`, with indexes, constraints, and RLS. Browser users can only read their own records; all mutations are performed by Edge Functions after the caller’s JWT and document ownership have been checked. No public table policy is added.

### Pinata/IPFS

`upload-document` needs `PINATA_JWT` as an Edge Function secret. It validates the `%PDF-` file signature and 25 MB limit, calculates the hash from server-received bytes, pins the file, validates Pinata’s returned CID, and persists the metadata. If Pinata succeeds but the database fails, the response contains recovery information; `recover-document` first proves that Pinata metadata belongs to the authenticated user before recording it.

IPFS retrieval/privacy is controlled by your Pinata configuration. Treat a CID as potentially publicly retrievable; do not upload confidential material without an appropriate storage and access plan.

## Polygon / wallet registration

The existing `contracts/EvidenceRegistry.sol` is retained. It supports `registerEvidence(bytes32)` and `getEvidence(bytes32)` with duplicate prevention and an `EvidenceRegistered` event.

Deploy it to an intended network (use Polygon Amoy for testing) with a separately secured deployment account. Do not deploy to mainnet automatically. Set these Edge Function secrets and matching local runtime variables:

```bash
supabase secrets set POLYGON_RPC_URL="https://your-rpc-provider"
supabase secrets set BLOCKCHAIN_CONTRACT_ADDRESS="0xYourDeployedRegistry"
supabase secrets set BLOCKCHAIN_NETWORK="polygon-amoy"
supabase secrets set BLOCKCHAIN_CHAIN_ID="80002"
```

Set the non-secret `BLOCKCHAIN_CONTRACT_ADDRESS`, `BLOCKCHAIN_NETWORK`, and `BLOCKCHAIN_CHAIN_ID` in `.env.local` for the UI too. A **Register on chain** action appears only when that public configuration exists. It asks the user’s browser wallet to sign, waits for its real receipt, and calls `confirm-blockchain-registration`, which independently checks the receipt and contract state through the server-side RPC before it marks the Supabase record as registered.

For the original Review 1 local demo, use three terminals:

```bash
npm run chain
npm run deploy:local
npm start
```

The local Hardhat signer in `server.js` is only retained for the legacy local `/api/register` demonstration endpoint. It is not used for the production-style dashboard or Polygon flow.

## Checks

```bash
npm run check
```

The test suite covers contract registration/duplicate prevention plus deterministic SHA-256, PDF-signature rejection, and empty-upload handling.

## Production hosting

Host the Express app (or serve `public/` through an equivalent Node host), configure its `.env.local`/host variables with only public browser configuration, set `APP_ORIGIN` to the hosted origin in Edge Function secrets, and enable that URL in Supabase Auth redirect URLs. Supabase provides the database/auth/functions; Pinata stores files; Polygon stores hash evidence only. Polygon does not host the website.
