import Foundation
import Security

/// Un compte, tel que le serveur le décrit. Miroir de `Compte` dans `@domo/shared`.
public struct Compte: Codable, Sendable, Identifiable, Equatable {
    public let id: String
    public let identifiant: String
    public let nom: String
    public let role: Role
    public let actif: Bool

    public enum Role: String, Codable, Sendable, Comparable {
        case invite, habitant, admin

        private var rang: Int {
            switch self { case .invite: 1; case .habitant: 2; case .admin: 3 }
        }
        public static func < (a: Role, b: Role) -> Bool { a.rang < b.rang }

        public var label: String {
            switch self {
            case .admin: "Administrateur"
            case .habitant: "Habitant"
            case .invite: "Invité"
            }
        }
    }
}

/// Un habitant tel que la page de connexion a le droit de le voir : un prénom
/// et un rôle, jamais l'identifiant de connexion.
public struct Habitant: Decodable, Sendable, Identifiable, Equatable {
    public let id: String
    public let nom: String
    public let initiale: String
    public let role: Compte.Role
}

/// Le jeton de session, rangé dans le trousseau.
///
/// Le serveur rend le jeton dans le corps de la connexion précisément pour
/// l'app iOS, qui n'a pas de magasin à cookies commode. Il vaut mot de passe :
/// il ne va ni dans `UserDefaults` ni dans un fichier, et il n'est lisible
/// qu'une fois le téléphone déverrouillé une première fois, sur cet appareil
/// seulement (pas de copie dans une sauvegarde restaurée ailleurs).
public enum Trousseau {
    private static let service = "fr.laruche.maison"
    private static let compte = "session"

    public static func lire() -> String? {
        let requete: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: compte,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var resultat: AnyObject?
        guard SecItemCopyMatching(requete as CFDictionary, &resultat) == errSecSuccess,
              let data = resultat as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    public static func ecrire(_ jeton: String) {
        effacer()
        let item: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: compte,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
            kSecValueData as String: Data(jeton.utf8),
        ]
        SecItemAdd(item as CFDictionary, nil)
    }

    public static func effacer() {
        let requete: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: compte,
        ]
        SecItemDelete(requete as CFDictionary)
    }
}
