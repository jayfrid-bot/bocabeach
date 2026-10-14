//
//  NearestLocator.swift
//
//  One-shot "Nearest beach". Location is requested only when the user taps
//  Nearest (When In Use), never in the background, and the fix is not stored.
//

import CoreLocation
import Foundation

@MainActor
final class NearestLocator: NSObject, ObservableObject, CLLocationManagerDelegate {
    enum State: Equatable {
        case idle
        case locating
        case found(slug: String, name: String, miles: Double)
        case denied
        case failed
    }

    @Published private(set) var state: State = .idle
    private let manager = CLLocationManager()

    override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyKilometer
    }

    func locate() {
        switch manager.authorizationStatus {
        case .denied, .restricted:
            state = .denied
        case .notDetermined:
            state = .locating
            manager.requestWhenInUseAuthorization()
        default:
            state = .locating
            manager.requestLocation()
        }
    }

    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        let status = manager.authorizationStatus
        Task { @MainActor in
            guard self.state == .locating else { return }
            switch status {
            case .denied, .restricted: self.state = .denied
            case .authorizedAlways, .authorizedWhenInUse: manager.requestLocation()
            default: break
            }
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let fix = locations.last else { return }
        let lat = fix.coordinate.latitude, lon = fix.coordinate.longitude
        Task { @MainActor in
            if let n = BeachCatalog.nearest(toLat: lat, lon: lon) {
                self.state = .found(slug: n.beach.slug, name: n.beach.name, miles: n.miles)
            } else {
                self.state = .failed
            }
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        let denied = (error as? CLError)?.code == .denied
        Task { @MainActor in self.state = denied ? .denied : .failed }
    }
}
