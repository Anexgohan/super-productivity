import { vi } from 'vitest';

/** An in-memory `prisma.deletedEntity` over the rows the caller holds, shared by the test harnesses that mock the database. */
export const createDeletedEntityMock = (rows: () => Map<string, any>) => {
  const keyOf = (row: any): string => `${row.userId}|${row.entityType}|${row.entityId}`;
  const matches = (row: any, where: any): boolean => {
    if (where?.userId !== undefined && row.userId !== where.userId) return false;
    if (where?.recordedAt?.lt !== undefined && !(row.recordedAt < where.recordedAt.lt)) {
      return false;
    }
    return (
      !Array.isArray(where?.OR) ||
      where.OR.some(
        (alt: any) => alt.entityType === row.entityType && alt.entityId === row.entityId,
      )
    );
  };
  const select = (row: any, fields?: Record<string, boolean>): any =>
    fields
      ? Object.fromEntries(
          Object.entries(fields)
            .filter(([, wanted]) => wanted)
            .map(([field]) => [field, row[field]]),
        )
      : row;

  return {
    findMany: vi.fn().mockImplementation(async (args: any) =>
      Array.from(rows().values())
        .filter((row) => matches(row, args?.where))
        .map((row) => select(row, args?.select)),
    ),
    createMany: vi.fn().mockImplementation(async (args: any) => {
      let count = 0;
      for (const row of args.data) {
        const key = keyOf(row);
        if (rows().has(key)) {
          if (args.skipDuplicates) continue;
          throw new Error('Unique constraint failed');
        }
        rows().set(key, { ...row });
        count++;
      }
      return { count };
    }),
    update: vi.fn().mockImplementation(async (args: any) => {
      const key = keyOf(args.where.userId_entityType_entityId);
      const existing = rows().get(key);
      if (!existing) throw new Error('Record to update not found');
      const updated = { ...existing, ...args.data };
      rows().set(key, updated);
      return updated;
    }),
    deleteMany: vi.fn().mockImplementation(async (args: any) => {
      let count = 0;
      for (const [key, row] of rows()) {
        if (matches(row, args?.where)) {
          rows().delete(key);
          count++;
        }
      }
      return { count };
    }),
  };
};
