/// Minimal standard Option algebra; no sentinel identities are used.
module basicSpells {
  type Option[a] = Some(a) | None
}
