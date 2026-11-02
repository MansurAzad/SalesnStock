type PageResponse<T> = {
  data: T[] | null;
  error: { message: string } | null;
};

type PageQuery<T> = {
  range: (from: number, to: number) => PromiseLike<PageResponse<T>>;
};

export async function fetchAllPages<T>(query: PageQuery<T>, pageSize = 1000): Promise<T[]> {
  const rows: T[] = [];

  for (let from = 0; ; from += pageSize) {
    const { data, error } = await query.range(from, from + pageSize - 1);
    if (error) throw error;
    const page = data ?? [];
    rows.push(...page);
    if (page.length < pageSize) return rows;
  }
}