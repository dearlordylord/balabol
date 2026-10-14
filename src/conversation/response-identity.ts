import { createHash } from "node:crypto"

// UUIDv5 gives an accepted input one stable response identity across backend restart.
export const responseIdentity = (inputDeliveryId: string) => {
  const namespace = Buffer.from("6ba7b8109dad11d180b400c04fd430c8", "hex")
  const bytes = createHash("sha1").update(namespace).update(`balabol.response:${inputDeliveryId}`).digest()
  const hex = bytes.toString("hex")
  const versionNibble = "5"
  const variantPosition = 16
  const hexRadix = 16
  const variantMask = 3
  const variantPrefix = 8
  const variantNibble = (
    (Number.parseInt(hex.charAt(variantPosition), hexRadix) & variantMask) |
    variantPrefix
  ).toString(hexRadix)
  const groupOneEnd = 8
  const groupTwoEnd = 12
  const groupThreeStart = 13
  const groupFourStart = 17
  const groupFourEnd = 20
  const uuidHexLength = 32
  return `${hex.slice(0, groupOneEnd)}-${hex.slice(groupOneEnd, groupTwoEnd)}-${versionNibble}${hex.slice(groupThreeStart, variantPosition)}-${variantNibble}${hex.slice(groupFourStart, groupFourEnd)}-${hex.slice(groupFourEnd, uuidHexLength)}`
}
