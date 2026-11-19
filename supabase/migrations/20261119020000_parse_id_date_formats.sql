-- parse_id_date: selain "11 Jul 2025", terima juga "11/07/2025", "11-07-2025" (hari/bulan/tahun)
-- dan "2025-07-11" (ISO). Format lain tetap menghasilkan NULL.
create or replace function public.parse_id_date(t text)
returns date language plpgsql immutable set search_path = '' as $$
declare parts text[]; m int; s text := btrim(coalesce(t, ''));
begin
  if s = '' then return null; end if;

  -- ISO: 2025-07-11
  if s ~ '^\d{4}-\d{1,2}-\d{1,2}$' then
    parts := string_to_array(s, '-');
    return make_date(parts[1]::int, parts[2]::int, parts[3]::int);
  end if;

  -- Angka: 11/07/2025, 11-07-2025, 11.07.2025, 11/07/25 (hari/bulan/tahun)
  if s ~ '^\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}$' then
    parts := regexp_split_to_array(s, '[/.-]');
    return make_date(
      case when length(parts[3]) = 2 then 2000 + parts[3]::int else parts[3]::int end,
      parts[2]::int, parts[1]::int);
  end if;

  -- Teks: 11 Jul 2025, 1 Agu 2026, 7 Mei 2026
  parts := regexp_split_to_array(s, '\s+');
  if array_length(parts, 1) <> 3 then return null; end if;
  m := case lower(left(parts[2], 3))
    when 'jan' then 1 when 'feb' then 2 when 'mar' then 3 when 'apr' then 4
    when 'mei' then 5 when 'may' then 5 when 'jun' then 6 when 'jul' then 7
    when 'agu' then 8 when 'aug' then 8 when 'sep' then 9 when 'okt' then 10
    when 'oct' then 10 when 'nov' then 11 when 'des' then 12 when 'dec' then 12
    else null end;
  if m is null then return null; end if;
  return make_date(parts[3]::int, m, parts[1]::int);
exception when others then return null;
end; $$;
