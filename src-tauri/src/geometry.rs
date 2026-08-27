use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct PhysPoint {
    pub x: i32,
    pub y: i32,
}

impl PhysPoint {
    pub fn new(x: i32, y: i32) -> Self {
        Self { x, y }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct PhysRect {
    pub x: i32,
    pub y: i32,
    pub w: u32,
    pub h: u32,
}

impl PhysRect {
    pub fn new(x: i32, y: i32, w: u32, h: u32) -> Self {
        Self { x, y, w, h }
    }

    pub fn from_points(a: PhysPoint, b: PhysPoint) -> Self {
        let x = a.x.min(b.x);
        let y = a.y.min(b.y);
        let w = (a.x - b.x).unsigned_abs().max(1);
        let h = (a.y - b.y).unsigned_abs().max(1);
        Self { x, y, w, h }
    }

    pub fn right(&self) -> i32 {
        self.x + self.w as i32
    }

    pub fn bottom(&self) -> i32 {
        self.y + self.h as i32
    }

    pub fn contains(&self, p: PhysPoint) -> bool {
        p.x >= self.x && p.x < self.right() && p.y >= self.y && p.y < self.bottom()
    }

    /// Returns the overlapping rect between `self` and `other`, or `None` if they don't overlap.
    pub fn intersect(&self, other: &PhysRect) -> Option<PhysRect> {
        let x = self.x.max(other.x);
        let y = self.y.max(other.y);
        let right = self.right().min(other.right());
        let bottom = self.bottom().min(other.bottom());

        if right <= x || bottom <= y {
            None
        } else {
            Some(PhysRect::new(x, y, (right - x) as u32, (bottom - y) as u32))
        }
    }

    pub fn union(&self, other: &PhysRect) -> PhysRect {
        let x = self.x.min(other.x);
        let y = self.y.min(other.y);
        let right = self.right().max(other.right());
        let bottom = self.bottom().max(other.bottom());

        PhysRect::new(x, y, (right - x) as u32, (bottom - y) as u32)
    }

}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn intersect_overlapping() {
        let a = PhysRect::new(0, 0, 10, 10);
        let b = PhysRect::new(5, 5, 10, 10);
        assert_eq!(a.intersect(&b), Some(PhysRect::new(5, 5, 5, 5)));
    }

    #[test]
    fn intersect_disjoint() {
        let a = PhysRect::new(0, 0, 10, 10);
        let b = PhysRect::new(20, 20, 10, 10);
        assert_eq!(a.intersect(&b), None);
    }

    #[test]
    fn union_covers_both() {
        let a = PhysRect::new(0, 0, 5120, 2880);
        let b = PhysRect::new(692, 2880, 3491, 1964);
        assert_eq!(a.union(&b), PhysRect::new(0, 0, 5120, 4844));
    }

    #[test]
    fn from_points_normalizes() {
        let r = PhysRect::from_points(PhysPoint::new(10, 10), PhysPoint::new(4, 6));
        assert_eq!(r, PhysRect::new(4, 6, 6, 4));
    }
}
