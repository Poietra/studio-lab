struct VertexInput {
    @location(0) position: vec2<f32>,
    @location(1) color: vec4<f32>,
    @location(2) stroke_coverage: vec2<f32>,
};

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) color: vec4<f32>,
    @location(1) stroke_coverage: vec2<f32>,
};

struct ClipPolygon {
    points: array<vec2<f32>, 8>,
    count: u32,
};

fn positive_square(value: f32) -> f32 {
    let positive = max(value, 0.0);
    return positive * positive;
}

fn projected_pixel_cdf(value: f32, extent_x: f32, extent_y: f32) -> f32 {
    // The projection of one square pixel onto a line normal is the sum of two
    // centered uniform distributions. This is their exact piecewise-quadratic
    // CDF, used below to integrate an infinite strip over the pixel footprint.
    let major_extent = max(extent_x, extent_y);
    let minor_extent = min(extent_x, extent_y);
    if minor_extent < 0.0001 {
        if major_extent < 0.0001 {
            return select(0.0, 1.0, value >= 0.0);
        }
        return clamp(value / major_extent + 0.5, 0.0, 1.0);
    }

    let half_sum = (extent_x + extent_y) * 0.5;
    let shifted = value + half_sum;
    return clamp(
        (
            positive_square(shifted)
            - positive_square(shifted - extent_x)
            - positive_square(shifted - extent_y)
            + positive_square(shifted - extent_x - extent_y)
        ) / (2.0 * extent_x * extent_y),
        0.0,
        1.0,
    );
}

fn clip_half_plane(input: ClipPolygon, center: f32, gradient: vec2<f32>) -> ClipPolygon {
    var output: ClipPolygon;
    output.count = 0u;
    if input.count == 0u {
        return output;
    }
    for (var index = 0u; index < input.count; index += 1u) {
        let previous_index = (index + input.count - 1u) % input.count;
        let previous = input.points[previous_index];
        let current = input.points[index];
        let previous_distance = center + dot(gradient, previous);
        let current_distance = center + dot(gradient, current);
        let previous_inside = previous_distance >= 0.0;
        let current_inside = current_distance >= 0.0;
        if previous_inside != current_inside {
            let fraction = previous_distance / (previous_distance - current_distance);
            output.points[output.count] = mix(previous, current, fraction);
            output.count += 1u;
        }
        if current_inside {
            output.points[output.count] = current;
            output.count += 1u;
        }
    }
    return output;
}

fn clipped_pixel_coverage(
    first_center: f32,
    first_gradient: vec2<f32>,
    second_center: f32,
    second_gradient: vec2<f32>,
    third_center: f32,
    third_gradient: vec2<f32>,
    plane_count: u32,
) -> f32 {
    var polygon: ClipPolygon;
    polygon.points[0] = vec2<f32>(-0.5, -0.5);
    polygon.points[1] = vec2<f32>(0.5, -0.5);
    polygon.points[2] = vec2<f32>(0.5, 0.5);
    polygon.points[3] = vec2<f32>(-0.5, 0.5);
    polygon.count = 4u;
    polygon = clip_half_plane(polygon, first_center, first_gradient);
    polygon = clip_half_plane(polygon, second_center, second_gradient);
    if plane_count == 3u {
        polygon = clip_half_plane(polygon, third_center, third_gradient);
    }
    if polygon.count < 3u {
        return 0.0;
    }
    var doubled_area = 0.0;
    for (var index = 0u; index < polygon.count; index += 1u) {
        let next_index = (index + 1u) % polygon.count;
        let current = polygon.points[index];
        let next = polygon.points[next_index];
        doubled_area += current.x * next.y - current.y * next.x;
    }
    return clamp(abs(doubled_area) * 0.5, 0.0, 1.0);
}

fn corrected_multisample_color(color: vec4<f32>, coverage: f32, sample_mask: u32) -> vec4<f32> {
    let covered_samples = f32(countOneBits(sample_mask & 15u));
    let multisample_coverage = covered_samples * 0.25;
    let correction = min(coverage / max(multisample_coverage, 0.25), 1.0);
    return color * correction;
}

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    output.position = vec4<f32>(input.position, 0.0, 1.0);
    output.color = input.color;
    output.stroke_coverage = input.stroke_coverage;
    return output;
}

@fragment
fn fs_main(input: VertexOutput, @builtin(sample_mask) sample_mask: u32) -> @location(0) vec4<f32> {
    let signed_distance = input.stroke_coverage.x;
    let original_half_width = input.stroke_coverage.y;
    let distance_dx = dpdx(signed_distance);
    let distance_dy = dpdy(signed_distance);
    let encoded_coverage_y_dx = dpdx(original_half_width);
    let encoded_coverage_y_dy = dpdy(original_half_width);
    if original_half_width == -2.0 {
        let extent_x = abs(distance_dx);
        let extent_y = abs(distance_dy);
        let analytic_coverage = projected_pixel_cdf(signed_distance, extent_x, extent_y);
        return corrected_multisample_color(input.color, analytic_coverage, sample_mask);
    }
    if original_half_width < -2.5 {
        let second_distance = select(
            -3.0 - original_half_width,
            -5.0 - original_half_width,
            original_half_width < -4.5,
        );
        let second_gradient = vec2<f32>(encoded_coverage_y_dx, encoded_coverage_y_dy) * -1.0;
        let has_third_plane = original_half_width < -4.5;
        let third_distance = 1.0 - signed_distance - second_distance;
        let third_gradient = -vec2<f32>(distance_dx, distance_dy) - second_gradient;
        let analytic_coverage = clipped_pixel_coverage(
            signed_distance,
            vec2<f32>(distance_dx, distance_dy),
            second_distance,
            second_gradient,
            third_distance,
            third_gradient,
            select(2u, 3u, has_third_plane),
        );
        return corrected_multisample_color(input.color, analytic_coverage, sample_mask);
    }
    if original_half_width < 0.0 {
        return input.color;
    }
    let extent_x = abs(distance_dx);
    let extent_y = abs(distance_dy);
    let coverage = projected_pixel_cdf(original_half_width - signed_distance, extent_x, extent_y)
        - projected_pixel_cdf(-original_half_width - signed_distance, extent_x, extent_y);
    return input.color * coverage;
}
