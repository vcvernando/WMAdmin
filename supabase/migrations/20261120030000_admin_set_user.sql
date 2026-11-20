-- Approve / tolak / ubah peran akun dari dashboard (khusus admin).
-- Saat disetujui, email akun ikut dikonfirmasi, sehingga user baru tidak bergantung
-- pada link konfirmasi email (Site URL Supabase bisa saja belum diarahkan ke dashboard).
create or replace function public.admin_set_user(p_id uuid, p_action text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_me uuid := auth.uid(); v_row public.profiles;
begin
  if not public.is_admin() then
    raise exception 'Hanya admin yang boleh mengubah akun.' using errcode = '42501';
  end if;
  if p_action not in ('approve', 'reject', 'admin', 'user') then
    raise exception 'Aksi tidak dikenal: %', p_action;
  end if;
  if p_id = v_me and p_action in ('reject', 'user') then
    raise exception 'Admin tidak bisa menolak atau menurunkan akunnya sendiri.';
  end if;

  update public.profiles p set
    status      = case p_action when 'approve' then 'approved' when 'reject' then 'rejected' else p.status end,
    role        = case p_action when 'admin' then 'admin' when 'user' then 'user' else p.role end,
    approved_at = case when p_action = 'approve' then now() else p.approved_at end,
    approved_by = case when p_action = 'approve' then v_me else p.approved_by end
  where p.id = p_id
  returning * into v_row;

  if v_row.id is null then
    raise exception 'Akun tidak ditemukan.';
  end if;

  if p_action = 'approve' then
    update auth.users set email_confirmed_at = coalesce(email_confirmed_at, now()) where id = p_id;
  end if;

  return jsonb_build_object('id', v_row.id, 'status', v_row.status, 'role', v_row.role);
end; $$;

revoke execute on function public.admin_set_user(uuid, text) from public, anon;
grant execute on function public.admin_set_user(uuid, text) to authenticated;
