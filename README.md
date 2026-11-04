# RI-SWAP

[Live app](https://ri-ecosys.org/ri-swap/) · [English video demo](https://youtu.be/dTL5e53flQc)

Exchange what you can offer for what you need. Hoa Mai helps clarify a draft; people review the terms and decide whether to save, propose or accept.

## Run locally

Use Node.js 22 or newer and PostgreSQL. Install dependencies with `npm ci`. Copy `.env.example` to a private `.env` and configure your own test database connection. Apply `migrations/001-durable-state.sql` to that test database using your database administrator's normal procedure. It creates tables, not roles or grants. Never point local tests at a production database.

Run `npm test`, then `npm start`. The server binds to `127.0.0.1:8787`; set `PORT` to change the port. The application requires durable PostgreSQL storage and exits when the database configuration is missing. OAuth and Meta features additionally require your own provider configuration. No credentials are distributed here.

Guests can browse offers/demo examples and request informational assistance. Saving or accepting a real exchange requires authentication. Demo examples are labelled separately. AI never accepts an agreement for either party.

## Current scope and evidence

This export combines the reviewed UI/API source with its preserved HTTP server and authentication modules. Offline tests exercise product contracts with injected test dependencies; they do not prove hosted execution or PostgreSQL durability. ROO's current public readback confirms selected served assets and a process-reported Meta success. A durable same-attempt input/output/UI receipt has not been reconstructed. Image/voice and external integrations remain gated according to their actual configured state. Ask System uses internal knowledge; the public export currently withholds knowledge answers until a reviewed, current knowledge binding is delivered.

The English video has been published by the Human-authorized operator. Independent anonymous full playback/readback remains to be recorded. Agreement Reached records consent; it does not establish payment, delivery or physical fulfilment.

## Tests and export

`npm test` runs the published product contract tests. Internal packet-inventory and manifest-lineage tests are excluded because they reference private release packaging. The internal evidence-only web server is excluded. `node_modules`, private environment files, mailbox, internal evidence and submission records are not part of the source export.

## License

Apache-2.0. See LICENSE and NOTICE. Third-party dependencies retain their respective licences. Media/voices in the separately reviewed video are not licensed by this source repository.


