import { describe, it, expect } from "vitest";
import { extract } from "../../scripts/sync-contract.mjs";

// CSD-668 F-07: the generator used to push every `ep({ … })` chunk it found, including the rows
// the seed stages `Enabled: false`. Those rows are seeded but kept out of routing and out of the
// generated OpenAPI, so copying them into the snapshot advertised endpoints that answer 404 — and
// would let a future tool targeting one of them pass the drift test and ship dead.
//
// The fixture is a miniature of the real seed's shape (an `ep()` helper defaulting Enabled: true,
// then rows that override it), so this runs offline in the public repo's CI, where the real seed
// is not mirrored.
const FIXTURE_SEED = `'use strict';
const READ = ['drive:read'];
const WRITE = ['drive:write'];
const ep = (o) => ({ ApiVersion: 'v1', Enabled: true, TargetLambdaArn: FN, ...o });
const allItems = [
    ep({ ApiPath: 'POST /storage/list', OperationId: 'storageList', Tag: 'Storage', RequiredScopes: READ, TargetHandlerPath: '/' }),
    ep({ ApiPath: 'POST /indexing/status', Enabled: false, OperationId: 'indexingStatus', Tag: 'Indexing', RequiredScopes: READ, TargetHandlerPath: '/c0f2a1b3',
        Description: 'Staged until release.' }),
    ep({ ApiPath: 'POST /storage/folder/create', Enabled: true, OperationId: 'createFolder', Tag: 'Storage', RequiredScopes: WRITE, TargetHandlerPath: '/storage/create/folder' }),
    ep({ ApiPath: 'POST /indexing/buckets/add', Enabled: false, OperationId: 'indexingAddBuckets', Tag: 'Indexing', RequiredScopes: WRITE, TargetHandlerPath: '/f4b941ed' })
];
module.exports = { allItems };
`;

describe("contract generator ↔ seed `Enabled` flag", () => {
  it("skips rows the seed stages `Enabled: false`", () => {
    const endpoints = extract(FIXTURE_SEED);

    expect(endpoints.map((e: { path: string }) => e.path)).toEqual(["/storage/folder/create", "/storage/list"]);
  });

  it("keeps rows that take the helper's `Enabled: true` default and rows that set it explicitly", () => {
    const paths = extract(FIXTURE_SEED).map((e: { path: string }) => e.path);

    expect(paths).toContain("/storage/list"); // default from ep()
    expect(paths).toContain("/storage/folder/create"); // explicit Enabled: true
  });

  it("maps an enabled row's method, scopes and handler path", () => {
    const endpoints = extract(FIXTURE_SEED) as Array<Record<string, unknown>>;
    const createFolder = endpoints.find((e) => e.path === "/storage/folder/create");

    expect(createFolder).toEqual({
      method: "POST",
      path: "/storage/folder/create",
      operationId: "createFolder",
      tag: "Storage",
      scopes: ["drive:write"],
      targetHandlerPath: "/storage/create/folder",
    });
  });

  it("extracts nothing from a seed with no endpoint rows, rather than inventing one", () => {
    expect(extract("'use strict';\nmodule.exports = { allItems: [] };\n")).toEqual([]);
  });

  // The seed is hand-maintained and reformatted by prettier, so `Enabled: false` is not
  // guaranteed to keep its single space — long rows in the real seed already wrap onto a
  // second line. A filter matching only the canonical spelling would let a staged row back
  // into the published contract the next time the seed is reflowed.
  it("recognises `Enabled: false` however the seed spaces or wraps it", () => {
    const reflowedSeed = `'use strict';
const READ = ['drive:read'];
const ep = (o) => ({ ApiVersion: 'v1', Enabled: true, ...o });
const allItems = [
    ep({ ApiPath: 'POST /storage/keep', OperationId: 'keep', Tag: 'Storage', RequiredScopes: READ, TargetHandlerPath: '/keep' }),
    ep({ ApiPath: 'POST /indexing/no-space', Enabled:false, OperationId: 'noSpace', Tag: 'Indexing', RequiredScopes: READ, TargetHandlerPath: '/no-space' }),
    ep({ ApiPath: 'POST /indexing/extra-spaces', Enabled:   false, OperationId: 'extraSpaces', Tag: 'Indexing', RequiredScopes: READ, TargetHandlerPath: '/extra-spaces' }),
    ep({ ApiPath: 'POST /indexing/wrapped',
        Enabled:
            false,
        OperationId: 'wrapped', Tag: 'Indexing', RequiredScopes: READ, TargetHandlerPath: '/wrapped' })
];
module.exports = { allItems };
`;

    expect(extract(reflowedSeed).map((e: { path: string }) => e.path)).toEqual(["/storage/keep"]);
  });
});
